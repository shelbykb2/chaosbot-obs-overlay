// Scene mirror: renders the preview (studio mode) or program scene, minus our own browser
// sources, to a small JPEG that http-server.cpp serves at /mirror.jpg.
//
// Threads: a UI-thread timer picks the scene and keeps a private copy of it (the real
// sources are shared, so no second capture). The graphics-thread render callback draws that
// copy into a texrender and reads it back; JPEG encoding happens on a worker thread.
//
// Locking rule: g_mutex only guards the g_dup pointer. No libobs call that can take the
// graphics or source locks (release, duplicate, signal connect) is made while holding it.
#include "mirror.hpp"
#include "http-server.hpp"
#include <obs-module.h>
#include <obs-frontend-api.h>
#include <plugin-support.h>
#include <QBuffer>
#include <QElapsedTimer>
#include <QImage>
#include <QThreadPool>
#include <QTimer>
#include <QtConcurrent/QtConcurrent>
#include <atomic>
#include <mutex>
#include <string>
#include <vector>

namespace overlay {
static const int kTickMs = 200;
static const int kActiveWindowMs = 2000;
static const int kRefreshMs = 2000;
static const int kMaxDepth = 8;
static const uint32_t kOutWidth = 960;
static const char *kMirrorName = "chaosbot-overlay-mirror";

static std::mutex g_mutex;            // guards g_dup (the pointer only)
static obs_source_t *g_dup = nullptr; // private copy of the mirrored scene

// UI thread only.
static QTimer *g_timer = nullptr;
static std::string g_dup_of;              // name of the scene g_dup was built from
static obs_source_t *g_watched = nullptr; // real scene whose signals we listen to (we hold a ref)
static qint64 g_built_at = 0;
static QElapsedTimer g_clock;

static std::atomic<bool> g_dirty{true};
static std::atomic<bool> g_want_frame{false};
static std::atomic<bool> g_encoding{false};
static std::atomic<uint32_t> g_base_w{1920}, g_base_h{1080};

// Graphics thread only.
static gs_texrender_t *g_tr = nullptr;
static gs_stagesurf_t *g_ss = nullptr;
static uint32_t g_ss_w = 0, g_ss_h = 0;

static bool starts_with(const char *s, const char *prefix) { return strncmp(s, prefix, strlen(prefix)) == 0; }

static bool is_ours(obs_source_t *src)
{
	if (strcmp(obs_source_get_id(src), "browser_source") != 0) return false;
	obs_data_t *s = obs_source_get_settings(src);
	const char *url = obs_data_get_string(s, "url");
	const bool ours = starts_with(url, "http://127.0.0.1:5260/") || starts_with(url, "http://localhost:5260/") ||
			  starts_with(url, "http://127.0.0.1:5051/") || starts_with(url, "http://localhost:5051/");
	obs_data_release(s);
	return ours;
}

static obs_scene_t *scene_or_group(obs_source_t *src)
{
	if (obs_scene_t *sc = obs_scene_from_source(src)) return sc;
	return obs_group_from_source(src);
}

// True when this source is ours, or a scene/group that holds ours somewhere inside.
static bool contains_ours(obs_source_t *src, int depth)
{
	if (is_ours(src)) return true;
	if (depth >= kMaxDepth) return false;
	obs_scene_t *sc = scene_or_group(src);
	if (!sc) return false;
	bool found = false;
	std::pair<bool *, int> args_(&found, depth);
	obs_scene_enum_items(
		sc,
		[](obs_scene_t *, obs_sceneitem_t *item, void *p) {
			auto *args = static_cast<std::pair<bool *, int> *>(p);
			if (contains_ours(obs_sceneitem_get_source(item), args->second + 1)) {
				*args->first = true;
				return false;
			}
			return true;
		},
		&args_);
	return found;
}

struct Pending {
	obs_sceneitem_t *item;
	obs_scene_t *child; // filtered copy for a nested scene/group, or null to just remove
};

static void copy_item_look(obs_sceneitem_t *from, obs_sceneitem_t *to)
{
	obs_transform_info info;
	obs_sceneitem_get_info2(from, &info);
	obs_sceneitem_set_info2(to, &info);
	obs_sceneitem_crop crop;
	obs_sceneitem_get_crop(from, &crop);
	obs_sceneitem_set_crop(to, &crop);
	obs_sceneitem_set_scale_filter(to, obs_sceneitem_get_scale_filter(from));
	obs_sceneitem_set_blending_method(to, obs_sceneitem_get_blending_method(from));
	obs_sceneitem_set_blending_mode(to, obs_sceneitem_get_blending_mode(from));
	obs_sceneitem_set_visible(to, obs_sceneitem_visible(from));
}

// Private copy of `real` without our sources. Nested scenes and groups that hold ours are
// replaced by their own filtered copies. Returns an owned scene (release it), or null.
static obs_scene_t *filtered_copy(obs_scene_t *real, int depth, int *removed)
{
	obs_scene_t *dup = obs_scene_duplicate(real, kMirrorName, OBS_SCENE_DUP_PRIVATE_REFS);
	if (!dup) return nullptr;

	std::vector<obs_sceneitem_t *> drop, swap;
	std::pair<std::vector<obs_sceneitem_t *> *, std::vector<obs_sceneitem_t *> *> lists_(&drop, &swap);
	obs_scene_enum_items(
		dup,
		[](obs_scene_t *, obs_sceneitem_t *item, void *p) {
			auto *lists = static_cast<std::pair<std::vector<obs_sceneitem_t *> *, std::vector<obs_sceneitem_t *> *> *>(p);
			obs_source_t *src = obs_sceneitem_get_source(item);
			if (is_ours(src)) {
				obs_sceneitem_addref(item);
				lists->first->push_back(item);
			} else if (scene_or_group(src) && contains_ours(src, 1)) {
				obs_sceneitem_addref(item);
				lists->second->push_back(item);
			}
			return true;
		},
		&lists_);

	for (obs_sceneitem_t *it : drop) {
		obs_sceneitem_remove(it);
		obs_sceneitem_release(it);
		(*removed)++;
	}
	for (obs_sceneitem_t *it : swap) {
		obs_scene_t *sub = depth + 1 < kMaxDepth ? scene_or_group(obs_sceneitem_get_source(it)) : nullptr;
		obs_scene_t *child = sub ? filtered_copy(sub, depth + 1, removed) : nullptr;
		if (child) {
			const int pos = obs_sceneitem_get_order_position(it);
			obs_sceneitem_t *ni = obs_scene_add(dup, obs_scene_get_source(child));
			if (ni) {
				copy_item_look(it, ni);
				obs_sceneitem_set_order_position(ni, pos);
			}
			obs_scene_release(child);
		}
		obs_sceneitem_remove(it);
		obs_sceneitem_release(it);
	}
	return dup;
}

static void on_scene_signal(void *, calldata_t *) { g_dirty = true; }

static const char *const kSignals[] = {"item_add", "item_remove", "reorder", "refresh"};

static void unwatch()
{
	if (!g_watched) return;
	signal_handler_t *sh = obs_source_get_signal_handler(g_watched);
	for (const char *sig : kSignals)
		signal_handler_disconnect(sh, sig, on_scene_signal, nullptr);
	obs_source_release(g_watched);
	g_watched = nullptr;
}

// Swaps the copy under the lock and releases the old one after it is unlocked.
static void set_dup(obs_source_t *fresh)
{
	obs_source_t *old;
	{
		std::lock_guard<std::mutex> l(g_mutex);
		old = g_dup;
		g_dup = fresh;
	}
	if (old) obs_source_release(old);
}

static void drop_dup()
{
	unwatch();
	set_dup(nullptr);
	g_dup_of.clear();
}

static obs_source_t *current_scene()
{
	return obs_frontend_preview_program_mode_active() ? obs_frontend_get_current_preview_scene()
							  : obs_frontend_get_current_scene();
}

static void update_base_size()
{
	obs_canvas_t *canvas = obs_get_main_canvas();
	obs_video_info ovi;
	if (canvas && obs_canvas_get_video_info(canvas, &ovi) && ovi.base_width && ovi.base_height) {
		g_base_w = ovi.base_width;
		g_base_h = ovi.base_height;
	}
	if (canvas) obs_canvas_release(canvas);
}

static void rebuild(obs_source_t *real)
{
	obs_scene_t *scene = obs_scene_from_source(real);
	if (!scene) return;
	int removed = 0;
	obs_scene_t *dup = filtered_copy(scene, 0, &removed);
	if (!dup) return;
	obs_source_t *fresh = obs_source_get_ref(obs_scene_get_source(dup));
	obs_scene_release(dup);

	set_dup(fresh);
	unwatch();
	g_watched = obs_source_get_ref(real);
	signal_handler_t *sh = obs_source_get_signal_handler(real);
	for (const char *sig : kSignals)
		signal_handler_connect(sh, sig, on_scene_signal, nullptr);
	g_dup_of = obs_source_get_name(real);
	g_built_at = g_clock.elapsed();
	g_dirty = false;
	obs_log(LOG_INFO, "mirror rebuilt from scene '%s' (%d overlay source(s) excluded)", g_dup_of.c_str(), removed);
}

static void tick()
{
	if (ms_since_mirror_request() > kActiveWindowMs) {
		if (!g_dup_of.empty()) drop_dup(); // nobody is looking: cost nothing
		return;
	}
	update_base_size();
	obs_source_t *real = current_scene();
	if (real) {
		const bool changed = g_dup_of != obs_source_get_name(real);
		// Also refresh every 2 s so edits to a source's URL setting are noticed.
		if (changed || g_dirty || g_clock.elapsed() - g_built_at > kRefreshMs || g_dup_of.empty()) rebuild(real);
		obs_source_release(real);
	}
	if (!g_dup_of.empty()) g_want_frame = true;
}

static void encode_job(QByteArray raw, int w, int h, int stride)
{
	QImage img(reinterpret_cast<const uchar *>(raw.constData()), w, h, stride, QImage::Format_RGB32);
	QByteArray jpeg;
	QBuffer buf(&jpeg);
	buf.open(QIODevice::WriteOnly);
	img.save(&buf, "JPEG", 70);
	set_mirror_frame(jpeg);
	g_encoding = false;
}

static void render_cb(void *, uint32_t, uint32_t)
{
	if (!g_want_frame.exchange(false) || g_encoding) return;

	// Take our own reference under the lock; render and release it outside the lock.
	obs_source_t *src = nullptr;
	{
		std::lock_guard<std::mutex> l(g_mutex);
		if (g_dup) src = obs_source_get_ref(g_dup);
	}
	if (!src) return;

	const uint32_t bw = g_base_w, bh = g_base_h;
	const uint32_t w = kOutWidth, h = kOutWidth * bh / bw;

	if (!g_tr) g_tr = gs_texrender_create(GS_BGRA, GS_ZS_NONE);
	if (!g_ss || g_ss_w != w || g_ss_h != h) {
		if (g_ss) gs_stagesurface_destroy(g_ss);
		g_ss = gs_stagesurface_create(w, h, GS_BGRA);
		g_ss_w = w;
		g_ss_h = h;
	}

	gs_texrender_reset(g_tr);
	if (gs_texrender_begin(g_tr, w, h)) {
		vec4 clear;
		vec4_zero(&clear);
		gs_clear(GS_CLEAR_COLOR, &clear, 0.0f, 0);
		gs_ortho(0.0f, (float)bw, 0.0f, (float)bh, -100.0f, 100.0f);
		gs_blend_state_push();
		gs_enable_blending(false);
		obs_source_video_render(src);
		gs_blend_state_pop();
		gs_texrender_end(g_tr);

		gs_stage_texture(g_ss, gs_texrender_get_texture(g_tr));
		uint8_t *data = nullptr;
		uint32_t linesize = 0;
		if (gs_stagesurface_map(g_ss, &data, &linesize)) {
			QByteArray raw(reinterpret_cast<const char *>(data), (qsizetype)linesize * h);
			gs_stagesurface_unmap(g_ss);
			g_encoding = true;
			(void)QtConcurrent::run(encode_job, raw, (int)w, (int)h, (int)linesize);
		}
	}
	obs_source_release(src);
}

void mirror_start()
{
	g_clock.start();
	update_base_size();
	obs_add_main_render_callback(render_cb, nullptr);
	g_timer = new QTimer();
	QObject::connect(g_timer, &QTimer::timeout, tick);
	g_timer->start(kTickMs);
	obs_log(LOG_INFO, "mirror ready (idle until /mirror.jpg is requested)");
}

void mirror_stop()
{
	delete g_timer;
	g_timer = nullptr;
	obs_remove_main_render_callback(render_cb, nullptr);
	drop_dup();
	QThreadPool::globalInstance()->waitForDone(2000);
	obs_enter_graphics();
	if (g_tr) gs_texrender_destroy(g_tr);
	if (g_ss) gs_stagesurface_destroy(g_ss);
	g_tr = nullptr;
	g_ss = nullptr;
	obs_leave_graphics();
}
} // namespace overlay
