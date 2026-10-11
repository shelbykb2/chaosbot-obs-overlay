#include "runtime.hpp"
#include "site.hpp"
#include "discovery.hpp"
#include <obs-module.h>
#include <plugin-support.h>
#include <QCoreApplication>
#include <QFileInfo>
#include <QProcess>
#include <QDir>
#ifdef Q_OS_WIN
#include <windows.h>
#endif

namespace overlay {
static QProcess *process = nullptr;
bool runtime_start()
{
    char *exe = obs_module_file("runtime/ChaosBot.Overlay.Runtime.exe");
    char *pages = obs_module_file("site");
    char *saved = obs_module_config_path("runtime-site");
    const QString program = QString::fromUtf8(exe ? exe : "");
    const QString folder = QString::fromUtf8(pages ? pages : "");
    const QString state = QString::fromUtf8(saved ? saved : "");
    bfree(exe); bfree(pages); bfree(saved);
    if (!QFileInfo::exists(program) || !QFileInfo::exists(folder + "/editor/index.html")) {
        obs_log(LOG_ERROR, "Overlay runtime or editor is missing. Reinstall the plugin.");
        return false;
    }
    process = new QProcess();
#ifdef Q_OS_WIN
    process->setCreateProcessArgumentsModifier([](QProcess::CreateProcessArguments *args) { args->flags |= CREATE_NO_WINDOW; });
#endif
    process->setStandardOutputFile(QProcess::nullDevice());
    process->setStandardErrorFile(QProcess::nullDevice());
    process->start(program, {"--site", state, "--companion-site", site_dir(), "--pages", folder, "--token", QString::fromLatin1(session_token()),
                            "--parent", QString::number(QCoreApplication::applicationPid())});
    if (!process->waitForStarted(3000)) {
        obs_log(LOG_ERROR, "Overlay runtime could not start.");
        delete process; process = nullptr; return false;
    }
    obs_log(LOG_INFO, "standalone runtime started");
    return true;
}
void runtime_stop()
{
    if (!process) return;
    process->terminate();
    if (!process->waitForFinished(2000)) { process->kill(); process->waitForFinished(2000); }
    delete process; process = nullptr;
}
}
