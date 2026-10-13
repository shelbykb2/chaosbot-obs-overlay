// OBS paints a browser source in obs-browser-page.exe. While a game is in front, Windows marks
// that process backgrounded: efficiency mode and a low priority. The overlay then drops frames
// and its motion falls behind. The page cannot change its own process. This plugin runs inside
// OBS, so it can, for every browser source, not only ours.
//
// Above normal, not high: every browser source gets this, and high would let them take CPU from
// the game. The work runs on its own thread so the OBS window never waits on it, and it slows to
// every 5 seconds while no browser source is running.
#include "schedule.hpp"

#include <obs-module.h>
#include <plugin-support.h>

#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <tlhelp32.h>
#endif

namespace overlay {
namespace {

std::thread worker;
std::mutex lock;
std::condition_variable wake;
bool stopping = false;

#ifdef _WIN32
constexpr DWORD kProcessPowerThrottling = 4;
constexpr ULONG kThrottleExecutionSpeed = 0x1;

void keep_one(DWORD pid)
{
	HANDLE process = OpenProcess(PROCESS_SET_INFORMATION, FALSE, pid);
	if (!process)
		return;

	SetPriorityClass(process, ABOVE_NORMAL_PRIORITY_CLASS);

	PROCESS_POWER_THROTTLING_STATE state = {};
	state.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
	state.ControlMask = kThrottleExecutionSpeed;
	state.StateMask = 0;
	SetProcessInformation(process, static_cast<PROCESS_INFORMATION_CLASS>(kProcessPowerThrottling), &state,
			      sizeof(state));
	CloseHandle(process);
}

// Returns how many browser source processes were running.
int keep_browsers()
{
	HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
	if (snap == INVALID_HANDLE_VALUE)
		return 0;

	int found = 0;
	PROCESSENTRY32W entry = {};
	entry.dwSize = sizeof(entry);
	if (Process32FirstW(snap, &entry)) {
		do {
			if (_wcsicmp(entry.szExeFile, L"obs-browser-page.exe") == 0) {
				keep_one(entry.th32ProcessID);
				++found;
			}
		} while (Process32NextW(snap, &entry));
	}
	CloseHandle(snap);
	return found;
}

void run()
{
	std::unique_lock<std::mutex> guard(lock);
	while (!stopping) {
		guard.unlock();
		const int found = keep_browsers();
		guard.lock();
		const auto wait = found > 0 ? std::chrono::milliseconds(500) : std::chrono::milliseconds(5000);
		wake.wait_for(guard, wait, [] { return stopping; });
	}
}
#endif

} // namespace

void schedule_start()
{
#ifdef _WIN32
	if (worker.joinable())
		return;
	{
		std::lock_guard<std::mutex> guard(lock);
		stopping = false;
	}
	worker = std::thread(run);
	obs_log(LOG_INFO, "browser sources stay scheduled while a game is in front");
#endif
}

void schedule_stop()
{
	{
		std::lock_guard<std::mutex> guard(lock);
		stopping = true;
	}
	wake.notify_all();
	if (worker.joinable())
		worker.join();
}

} // namespace overlay
