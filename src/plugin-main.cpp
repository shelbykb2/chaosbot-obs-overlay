// ChaosBot Overlay plugin entry. One file per concern: http-server, site, sync, discovery, mirror, dock.
#include <obs-module.h>
#include <obs-frontend-api.h>
#include <plugin-support.h>
#include "discovery.hpp"
#include "dock.hpp"
#include "http-server.hpp"
#include "mirror.hpp"
#include "runtime.hpp"
#include "schedule.hpp"
#ifdef _WIN32
#include <windows.h>
static HANDLE running_mutex = nullptr;
#endif

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE(PLUGIN_NAME, "en-US")

static bool g_serving = false;

static void on_frontend_event(enum obs_frontend_event event, void *)
{
	// Qt and the main window are only ready once OBS finished loading.
	if (event == OBS_FRONTEND_EVENT_FINISHED_LOADING) {
		overlay::schedule_start();
		g_serving = overlay::start_http_server();
		if (g_serving) {
			overlay::write_discovery(overlay::kPluginPort);
			overlay::runtime_start();
			overlay::mirror_start();
			overlay::add_status_dock();
		}
	} else if (event == OBS_FRONTEND_EVENT_EXIT) {
		overlay::schedule_stop();
		if (g_serving) overlay::remove_discovery();
		if (g_serving) {
			overlay::mirror_stop();
			overlay::runtime_stop();
			overlay::stop_http_server();
		}
		g_serving = false;
	}
}

bool obs_module_load(void)
{
#ifdef _WIN32
    running_mutex = CreateMutexW(nullptr, FALSE, L"ChaosBotOBSOverlayRunning");
#endif
	obs_log(LOG_INFO, "loaded (plugin %s, OBS %s)", PLUGIN_VERSION, obs_get_version_string());
	obs_frontend_add_event_callback(on_frontend_event, nullptr);
	return true;
}

void obs_module_unload(void)
{
	obs_frontend_remove_event_callback(on_frontend_event, nullptr);
	if (g_serving) {
		obs_frontend_remove_dock("chaosbot-overlay-status");
		overlay::mirror_stop();
		overlay::runtime_stop();
		overlay::stop_http_server();
		overlay::remove_discovery();
	}
	g_serving = false;
#ifdef _WIN32
    if (running_mutex) { CloseHandle(running_mutex); running_mutex = nullptr; }
#endif
	obs_log(LOG_INFO, "unloaded");
}
