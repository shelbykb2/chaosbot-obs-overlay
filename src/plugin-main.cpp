// ChaosBot Overlay plugin entry. One file per concern: http-server, site, sync, discovery, mirror, dock.
#include <obs-module.h>
#include <obs-frontend-api.h>
#include <plugin-support.h>
#include "discovery.hpp"
#include "dock.hpp"
#include "http-server.hpp"
#include "mirror.hpp"

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE(PLUGIN_NAME, "en-US")

static bool g_serving = false;

static void on_frontend_event(enum obs_frontend_event event, void *)
{
	// Qt and the main window are only ready once OBS finished loading.
	if (event == OBS_FRONTEND_EVENT_FINISHED_LOADING) {
		g_serving = overlay::start_http_server();
		if (g_serving) overlay::write_discovery(overlay::kPluginPort);
		overlay::mirror_start();
		overlay::add_status_dock();
	} else if (event == OBS_FRONTEND_EVENT_EXIT) {
		if (g_serving) overlay::remove_discovery();
		overlay::mirror_stop();
		overlay::stop_http_server();
		g_serving = false;
	}
}

bool obs_module_load(void)
{
	obs_log(LOG_INFO, "loaded (plugin %s, OBS %s)", PLUGIN_VERSION, obs_get_version_string());
	obs_frontend_add_event_callback(on_frontend_event, nullptr);
	return true;
}

void obs_module_unload(void)
{
	obs_frontend_remove_event_callback(on_frontend_event, nullptr);
	obs_log(LOG_INFO, "unloaded");
}
