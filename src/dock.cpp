// "Overlay" dock: a plain Qt status page (no browser needed).
#include "dock.hpp"
#include "http-server.hpp"
#include "sync.hpp"
#include <obs-module.h>
#include <obs-frontend-api.h>
#include <plugin-support.h>
#include <QApplication>
#include <QClipboard>
#include <QHBoxLayout>
#include <QLabel>
#include <QPushButton>
#include <QTimer>
#include <QVBoxLayout>
#include <QWidget>

namespace overlay {
static const qint64 kConnectedMs = 60000;

static QWidget *address_row(QWidget *parent, const QString &label, const QString &url)
{
	auto *row = new QWidget(parent);
	auto *lay = new QHBoxLayout(row);
	lay->setContentsMargins(0, 0, 0, 0);
	auto *text = new QLabel(QString("%1: %2").arg(label, url), row);
	text->setTextInteractionFlags(Qt::TextSelectableByMouse);
	auto *copy = new QPushButton("Copy", row);
	QObject::connect(copy, &QPushButton::clicked, row, [url] { QApplication::clipboard()->setText(url); });
	lay->addWidget(text, 1);
	lay->addWidget(copy);
	return row;
}

void add_status_dock()
{
	auto *root = new QWidget();
	auto *lay = new QVBoxLayout(root);
	lay->setContentsMargins(8, 8, 8, 8);
	lay->addWidget(new QLabel("Your overlay is served from this plugin.", root));
	const QString base = QString("http://127.0.0.1:%1/").arg(kPluginPort);
	lay->addWidget(address_row(root, "Chaos", base));
	lay->addWidget(address_row(root, "Spotify", base + "spotify/"));
	auto *status = new QLabel(root);
	lay->addWidget(status);
	lay->addStretch(1);

	auto *timer = new QTimer(root);
	auto refresh = [status] {
		status->setText(ms_since_last_sync() < kConnectedMs ? "ChaosBot is connected." : "ChaosBot is not connected.");
	};
	QObject::connect(timer, &QTimer::timeout, root, refresh);
	refresh();
	timer->start(1000);

	const bool ok = obs_frontend_add_dock_by_id("chaosbot-overlay-status", "Overlay", root);
	obs_log(LOG_INFO, "dock added: %s", ok ? "yes" : "no");
}
} // namespace overlay
