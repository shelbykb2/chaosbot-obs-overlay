// OBS paints a browser source in obs-browser-page.exe. While a game is in front, Windows marks
// that process backgrounded: efficiency mode and a low priority. The overlay then drops frames
// and its motion falls behind. The page cannot change its own process. This plugin runs inside
// OBS, so it can, for every browser source, not only ours.
#include "schedule.hpp"

#include <obs-module.h>
#include <plugin-support.h>

#include <QTimer>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <tlhelp32.h>
#endif

namespace overlay {
namespace {

QTimer *timer = nullptr;

#ifdef _WIN32
constexpr DWORD kProcessPowerThrottling = 4;
constexpr ULONG kThrottleExecutionSpeed = 0x1;

void keep_one(DWORD pid)
{
	HANDLE process = OpenProcess(PROCESS_SET_INFORMATION, FALSE, pid);
	if (!process)
		return;

	SetPriorityClass(process, HIGH_PRIORITY_CLASS);

	PROCESS_POWER_THROTTLING_STATE state = {};
	state.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
	state.ControlMask = kThrottleExecutionSpeed;
	state.StateMask = 0;
	SetProcessInformation(process, static_cast<PROCESS_INFORMATION_CLASS>(kProcessPowerThrottling), &state,
			      sizeof(state));
	CloseHandle(process);
}

void keep_browsers()
{
	HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
	if (snap == INVALID_HANDLE_VALUE)
		return;

	PROCESSENTRY32W entry = {};
	entry.dwSize = sizeof(entry);
	if (Process32FirstW(snap, &entry)) {
		do {
			if (_wcsicmp(entry.szExeFile, L"obs-browser-page.exe") == 0)
				keep_one(entry.th32ProcessID);
		} while (Process32NextW(snap, &entry));
	}
	CloseHandle(snap);
}
#endif

} // namespace

void schedule_start()
{
#ifdef _WIN32
	if (timer)
		return;
	keep_browsers();
	timer = new QTimer();
	timer->setInterval(500);
	QObject::connect(timer, &QTimer::timeout, timer, [] { keep_browsers(); });
	timer->start();
	obs_log(LOG_INFO, "browser sources stay scheduled while a game is in front");
#else
	(void)timer;
#endif
}

void schedule_stop()
{
	delete timer;
	timer = nullptr;
}

} // namespace overlay
