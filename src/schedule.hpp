#pragma once

namespace overlay {

// Keep OBS browser sources painting while a game is the foreground window.
void schedule_start();
void schedule_stop();

}
