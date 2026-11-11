#pragma once

namespace overlay {

// Keep OBS browser sources painting while a game is the foreground window.
void schedule_start();
void schedule_stop();
// True while that work runs (Windows only). The discovery file says so, and ChaosBot then
// stops its own copy of the same loop, so only one runs.
bool schedule_running();

}
