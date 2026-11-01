import { Button, TooltipButton, cx } from "../ui";
import { IconCloudDown, IconDownload, IconMore } from "../icons";
import { AnchoredMenu } from "./AnchoredMenu";
import { SearchField } from "../../features/plugins/presentation";
import { InstalledPluginsPanel } from "../../features/plugins/InstalledPluginsPanel";
import { MarketplacePanel } from "../../features/plugins/MarketplacePanel";
import { PluginDetailSheet } from "../../features/plugins/PluginDetailSheet";
import { PluginDialogs } from "../../features/plugins/PluginDialogs";
import { usePluginsPage } from "../../features/plugins/usePluginsPage";

/**
 * Settings ▸ Extensions (扩展插件).
 *
 * The plugins workbench hosted as an agent capability destination: the same
 * `usePluginsPage` state, the same installed/market panels, detail sheet, and
 * dialogs the sidebar 扩展 page renders — one implementation, two entrances.
 * Only the route chrome (page frame and title block) is dropped, because the
 * settings shell owns the page title.
 */
export function AgentExtensionsPage() {
  const page = usePluginsPage();
  const {
    t,
    tab,
    setTab,
    refreshMarket,
    query,
    setQuery,
    headerMenu,
    setHeaderMenu,
    overflowActions,
    stats,
    plugins,
    installedQuery,
    filteredInstalled,
    setInstalledQuery,
    marketLoading,
    market,
    applyAutoUpdates,
  } = page;

  return (
    <div className="settings-panel extensions-settings">
      <div className="plugins-toolbar">
        <div className="plugins-segment" role="tablist" aria-label={t("settings.extensions")}>
          <button
            type="button"
            role="tab"
            id="plugins-tab-installed"
            aria-selected={tab === "installed"}
            aria-controls="plugins-panel-installed"
            className={cx("plugins-segment-btn", tab === "installed" && "active")}
            onClick={() => setTab("installed")}
          >
            {t("plugins.tabInstalled")}
            <span className="plugins-segment-count">{stats.total}</span>
          </button>
          <button
            type="button"
            role="tab"
            id="plugins-tab-market"
            aria-selected={tab === "market"}
            aria-controls="plugins-panel-market"
            className={cx("plugins-segment-btn", tab === "market" && "active")}
            onClick={() => setTab("market")}
          >
            {t("plugins.tabMarket")}
            {market.length ? (
              <span className="plugins-segment-count">{market.length}</span>
            ) : null}
          </button>
        </div>
        <div className="plugins-toolbar-end">
          {tab === "installed" ? (
            plugins.length ? (
              <>
                {installedQuery.trim() ? (
                  <span className="plugins-result-count" aria-live="polite">
                    {t("plugins.resultCount", {
                      count: filteredInstalled.length,
                      total: plugins.length,
                    })}
                  </span>
                ) : null}
                <SearchField
                  value={installedQuery}
                  onChange={setInstalledQuery}
                  placeholder={t("plugins.searchInstalled")}
                />
              </>
            ) : (
              <Button variant="primary" size="sm" onClick={() => setTab("market")}>
                <IconDownload size={14} />
                {t("plugins.browseMarket")}
              </Button>
            )
          ) : (
            <>
              {marketLoading ? (
                <span className="plugins-result-count" aria-live="polite">
                  {t("plugins.marketLoading")}
                </span>
              ) : null}
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder={t("plugins.marketSearchPlaceholder")}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => void refreshMarket(query, { refreshRemote: true })}
              >
                <IconCloudDown size={14} />
                {t("plugins.refreshMarket")}
              </Button>
            </>
          )}
          <AnchoredMenu
            className="plugins-menu-wrap"
            open={headerMenu}
            onClose={() => setHeaderMenu(false)}
            menuClassName="plugins-menu is-end"
            label={t("plugins.moreActions")}
            role="menu"
            align="end"
            trigger={(ref) => (
              <TooltipButton
                ref={ref}
                type="button"
                className="plugins-icon-btn plugins-header-menu"
                ariaLabel={t("plugins.moreActions")}
                tooltip={t("plugins.moreActions")}
                aria-haspopup="menu"
                aria-expanded={headerMenu}
                onClick={() => setHeaderMenu((open) => !open)}
              >
                <IconMore size={16} />
              </TooltipButton>
            )}
          >
            {overflowActions.map((action) => (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                data-action={action.key}
                onClick={() => {
                  setHeaderMenu(false);
                  void action.run();
                }}
              >
                {t(`plugins.${action.key}`)}
              </button>
            ))}
          </AnchoredMenu>
        </div>
      </div>

      {stats.updates > 0 ? (
        <div className="plugins-alert" role="status">
          <span className="plugins-alert-icon" aria-hidden>
            <IconCloudDown size={15} />
          </span>
          <div className="plugins-alert-copy">
            <span className="plugins-alert-title">
              {t("plugins.updatesReady", { count: stats.updates })}
            </span>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void applyAutoUpdates()}>
            {t("plugins.applyAutoUpdates")}
          </Button>
        </div>
      ) : null}

      {tab === "installed" ? (
        <InstalledPluginsPanel {...page} />
      ) : (
        <MarketplacePanel {...page} />
      )}

      <PluginDetailSheet {...page} />
      <PluginDialogs {...page} />
    </div>
  );
}
