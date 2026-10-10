// "Overlay" dock: a plain Qt status page (no browser needed).
#include "dock.hpp"
#include "http-server.hpp"
#include "sync.hpp"
#include "discovery.hpp"
#include "../third_party/browser-panel.hpp"
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
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPointer>

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
	root->setMinimumSize(400, 360);
	auto *status = new QLabel("Starting your overlay editor…", root);
	lay->addWidget(status);
	auto *timer = new QTimer(root);
	auto *net = new QNetworkAccessManager(root);
	QObject::connect(timer, &QTimer::timeout, root, [root, lay, status, timer, net] {
		QNetworkRequest request(QUrl("http://127.0.0.1:5261/health"));
		request.setTransferTimeout(1000);
		auto *reply = net->get(request);
		QObject::connect(reply, &QNetworkReply::finished, root, [root, lay, status, timer, reply] {
			const bool ready = reply->error() == QNetworkReply::NoError;
			reply->deleteLater();
			if (!ready) { status->setText("Waiting for the overlay service. If this persists, reinstall the plugin."); return; }
			timer->stop();
			QCef *cef = obs_browser_init_panel();
			if (!cef || !cef->init_browser()) { status->setText("The OBS Browser component is required. Reinstall OBS with Browser support."); return; }
			char *cookiePath = obs_module_config_path("browser");
			auto *cookies = cef->create_cookie_manager(cookiePath ? cookiePath : "", false);
			bfree(cookiePath);
			const std::string url = (QByteArray("http://127.0.0.1:5261/editor/?token=") + session_token()).toStdString();
			auto *browser = cef->create_widget(root, url, cookies);
			if (!browser) { status->setText("OBS could not open the overlay editor."); return; }
			browser->allowAllPopups(false);
			lay->removeWidget(status); status->deleteLater();
			lay->setContentsMargins(0, 0, 0, 0);
			lay->addWidget(browser);
		});
	});
	timer->start(500);

	const bool ok = obs_frontend_add_dock_by_id("chaosbot-overlay-status", "Overlay", root);
	obs_log(LOG_INFO, "dock added: %s", ok ? "yes" : "no");
}
} // namespace overlay
