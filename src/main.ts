import { Plugin, WorkspaceLeaf, FileView, TFile, PluginSettingTab, App, Setting, normalizePath, TFolder, Notice, requestUrl } from "obsidian";

interface UrlViewerSettings {
    openInBrowser: boolean;
    fullscreenMode: boolean;
    autoFetchTitle: boolean;
}

const DEFAULT_SETTINGS: UrlViewerSettings = {
    openInBrowser: false,
    fullscreenMode: false,
    autoFetchTitle: true
}

const VIEW_TYPE_WEB = "url-webview";

// obsidian.d.ts does not expose a type for Electron's <webview> element,
// so we declare only the surface we actually use.
type WebviewTag = HTMLElement & {
    src: string;
    reload: () => void;
    goBack: () => void;
    goForward: () => void;
    canGoBack: () => boolean;
    canGoForward: () => boolean;
};

export default class UrlInternalViewerPlugin extends Plugin {
    settings: UrlViewerSettings;

    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE_WEB, (leaf) => new UrlWebView(leaf, this));
        this.registerExtensions(["url"], VIEW_TYPE_WEB);
        this.addSettingTab(new UrlViewerSettingTab(this.app, this));
        this.addCreateUrlFileShortcuts();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.refreshViews();
    }

    private refreshViews() {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof UrlWebView) {
                leaf.view.updateFullscreenMode();
            }
        });
    }

    private addCreateUrlFileShortcuts() {
        this.addRibbonIcon('link-2', 'Create .url file', async () => await this.createAndEditUrlFile());
        
        this.addCommand({
            id: "create-url-file",
            name: "Create .url file",
            callback: async () => await this.createAndEditUrlFile(),
        });

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file, _source) => {
                if (file instanceof TFolder) {
                    menu.addItem((item) =>
                        item
                            .setTitle("Create .url file")
                            .setIcon("link-2")
                            .onClick(async () => await this.createAndEditUrlFile(file.path + "/URL " + Date.now() + ".url"))
                    );
                } else if (file instanceof TFile && file.extension === 'url') {
                    menu.addItem((item) =>
                        item
                            .setTitle("Edit URL")
                            .setIcon("edit")
                            .onClick(async () => {
                                const leaf = this.app.workspace.getLeaf(true);
                                await leaf.openFile(file);
                                const view = leaf.view;
                                if (view instanceof UrlWebView) {
                                    view.startEditing(false);
                                }
                            })
                    );
                }
            })
        );
    }

    private async createAndEditUrlFile(path?: string) {
        const fileName = `URL ${Date.now()}.url`;
        const content = `[InternetShortcut]\nURL=\n`;
        if (path == null) {
            const activeFile = this.app.workspace.getActiveFile();
            const parentFolder = this.app.fileManager.getNewFileParent(activeFile?.path ?? "");
            path = normalizePath(`${parentFolder.path}/${fileName}`);
        }
        const created = await this.app.vault.create(path, content);
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.openFile(created);
        const view = leaf.view;
        if (view instanceof UrlWebView) {
            view.startEditing(true);
        }
    }
}

class UrlWebView extends FileView {
    private plugin: UrlInternalViewerPlugin;
    private isEditing: boolean = false;
    private headerHidden: boolean = false;
    private webviewEl: WebviewTag | null = null;
    private backActionEl: HTMLElement | null = null;
    private forwardActionEl: HTMLElement | null = null;
    private deleteOnCancelIfUntouched: boolean = false;

    constructor(leaf: WorkspaceLeaf, plugin: UrlInternalViewerPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    private get settings() {
        return this.plugin.settings;
    }

    private extractUrl(content: string): string {
        let url = content.trim();
        if (content.includes('[InternetShortcut]')) {
            const match = content.match(/URL=(.+)/);
            if (match) url = match[1].trim();
        }
        return this.normalizeUrl(url);
    }

    getViewType(): string {
        return VIEW_TYPE_WEB;
    }

    getDisplayText(): string {
        return this.file?.basename || "URL Viewer";
    }

    protected async onOpen(): Promise<void> {
        this.containerEl.addClass("url-webview-opener");
        this.updateFullscreenMode();
        this.addAction("edit", "Edit URL", () => this.toggleEditMode());
        this.addAction("external-link", "Open in browser", () => this.openInBrowser());
        this.addAction("refresh-cw", "Reload", () => this.webviewReload());
        this.addAction("arrow-right", "Forward", () => this.webviewGoForward());
        this.addAction("arrow-left", "Back", () => this.webviewGoBack());
    }

    updateFullscreenMode() {
        if (this.settings.fullscreenMode) {
            this.containerEl.addClass("fullscreen-mode");
            this.headerHidden = true;
            this.containerEl.addClass("header-hidden");
        } else {
            this.containerEl.removeClass("fullscreen-mode");
            this.headerHidden = false;
            this.containerEl.removeClass("header-hidden");
        }
    }

    async onLoadFile(file: TFile): Promise<void> {
        const content = await this.app.vault.read(file);
        const url = this.extractUrl(content);      
        window.setTimeout(() => {
            if (this.isEditing || !isValidUrl(url)) {
                this.showEditMode(file, content);
            } else {
                if (this.settings.openInBrowser) {
                    window.open(url, "_blank");
                    this.leaf.detach();
                    return;
                } else {
                    this.showViewMode(url);
                }
            }
        }, 0);
    }

    private updateActionStates() {
        if (!isWebviewTag(this.webviewEl)) return;
        if (this.backActionEl) {
            this.backActionEl.toggleClass("is-disabled", !this.webviewEl.canGoBack());
        }
        if (this.forwardActionEl) {
            this.forwardActionEl.toggleClass("is-disabled", !this.webviewEl.canGoForward());
        }
    }

    private webviewGoBack() {
        if (isWebviewTag(this.webviewEl)) this.webviewEl.goBack();
    }
    private webviewGoForward() {
        if (isWebviewTag(this.webviewEl)) this.webviewEl.goForward();
    }
    private webviewReload() {
        if (isWebviewTag(this.webviewEl)) this.webviewEl.reload();
    }

    private showViewMode(url: string) {
        const container = this.containerEl.children[1];
        container.empty();

        const webviewEl = activeDocument.createElement("webview");
        if (!isWebviewTag(webviewEl)) {
            console.error("webviewEl is not a WebviewTag");
            return;
        }

        webviewEl.src = url;
        webviewEl.addClass("url-webview-frame");
        container.appendChild(webviewEl);
        this.webviewEl = webviewEl;

        const actions = this.containerEl.querySelectorAll('.view-action');
        this.backActionEl = actions[0] as HTMLElement;
        this.forwardActionEl = actions[1] as HTMLElement;

        const updateNav = () => this.updateActionStates();
        webviewEl.addEventListener("did-navigate", updateNav);
        webviewEl.addEventListener("did-navigate-in-page", updateNav);
        webviewEl.addEventListener("dom-ready", updateNav);

        if (this.settings.fullscreenMode) {
            const chevron = container.createEl("div", {
                cls: "chevron-toggle",
                text: "⟩"
            });
            chevron.onclick = () => this.toggleHeader();
        }
    }

    private toggleHeader() {
        this.headerHidden = !this.headerHidden;
        if (this.headerHidden) {
            this.containerEl.addClass("header-hidden");
        } else {
            this.containerEl.removeClass("header-hidden");
        }
        const chevron = this.containerEl.querySelector('.chevron-toggle');
        if (chevron) chevron.textContent = "⟩";
    }

    private showEditMode(file: TFile, content: string) {
        const container = this.containerEl.children[1];
        container.empty();

        const editContainer = container.createDiv("url-webview-opener-edit");
        const textarea = editContainer.createEl("textarea", { cls: "url-textarea" });
        textarea.value = content;

        const btnContainer = editContainer.createDiv("url-edit-buttons");
        
        const saveBtn = btnContainer.createEl("button", { text: "Save", cls: "btn-edit" });
        saveBtn.onclick = async () => {
            await this.app.vault.modify(file, textarea.value);
            this.isEditing = false;
            const freshCreate = this.deleteOnCancelIfUntouched;
            this.deleteOnCancelIfUntouched = false;
            if (freshCreate && this.settings.autoFetchTitle) {
                const url = this.extractUrl(textarea.value);
                if (isValidUrl(url)) {
                    await this.tryFetchAndRename(file, url);
                }
            }
            await this.onLoadFile(file);
        };

        const cancelBtn = btnContainer.createEl("button", { text: "Cancel", cls: "btn-edit" });
        cancelBtn.onclick = async () => {
            if (this.deleteOnCancelIfUntouched) {
                const currentContent = await this.app.vault.read(file);
                if (this.isEmptyUrlContent(currentContent)) {
                    await this.app.fileManager.trashFile(file);
                    this.isEditing = false;
                    this.deleteOnCancelIfUntouched = false;
                    this.leaf.detach();
                    return;
                }
            }
            this.isEditing = false;
            this.deleteOnCancelIfUntouched = false;
            await this.onLoadFile(file);
        };
    }

    private normalizeUrl(url: string): string {
        const trimmed = url.trim();
        if (!trimmed) return trimmed;
        if (/^[a-zA-Z][a-zA-Z0-9+.+-]*:/.test(trimmed)) return trimmed;
        const withoutSlashes = trimmed.replace(/^\/\//, "");
        return `https://${withoutSlashes}`;
    }

    public startEditing(deleteOnCancelIfUntouched: boolean = false) {
        this.isEditing = true;
        this.deleteOnCancelIfUntouched = deleteOnCancelIfUntouched;
        if (this.file != null) void this.onLoadFile(this.file);
    }

    private isEmptyUrlContent(content: string): boolean {
        const trimmed = content.trim();
        if (trimmed.length === 0) return true;
        if (trimmed.includes('[InternetShortcut]')) {
            const match = content.match(/URL=(.*)/);
            if (!match) return true;
            const value = (match[1] ?? '').trim();
            return value.length === 0;
        }
        return trimmed.length === 0;
    }

    private toggleEditMode() {
        this.isEditing = !this.isEditing;
        if (this.file) void this.onLoadFile(this.file);
    }

    private async openInBrowser() {
        if (this.file) {
            const content = await this.app.vault.read(this.file);
            const url = this.extractUrl(content);
            window.open(url, "_blank");
        }
    }

    private async tryFetchAndRename(file: TFile, url: string): Promise<void> {
        let raw: string | null = null;
        try {
            const res = await requestUrl({ url, method: 'GET' });
            raw = extractTitleFromHtml(res.text);
        } catch { /* fall through */ }
        const sanitized = raw ? sanitizeFilename(decodeHtmlEntities(raw)) : "";
        if (!sanitized) { new Notice("Could not fetch title"); return; }
        const parentPath = file.parent ? file.parent.path : "";
        const prefix = parentPath && parentPath !== "/" ? `${parentPath}/` : "";
        let candidate = normalizePath(`${prefix}${sanitized}.url`);
        for (let i = 1; this.app.vault.getAbstractFileByPath(candidate); i++) {
            candidate = normalizePath(`${prefix}${sanitized} (${i}).url`);
        }
        try {
            await this.app.fileManager.renameFile(file, candidate);
            new Notice(`Renamed to ${sanitized}`);
        } catch { new Notice("Rename failed"); }
    }
}

class UrlViewerSettingTab extends PluginSettingTab {
    plugin: UrlInternalViewerPlugin;

    constructor(app: App, plugin: UrlInternalViewerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        
        new Setting(containerEl)
            .setName('Open in browser by default')
            .setDesc('Open URL files directly in browser instead of webview')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.openInBrowser)
                .onChange(async (value) => {
                    this.plugin.settings.openInBrowser = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Fullscreen mode')
            .setDesc('Hide toolbar and show floating navigation buttons for maximum space')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.fullscreenMode)
                .onChange(async (value) => {
                    this.plugin.settings.fullscreenMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto-fetch URL title on save')
            .setDesc('Automatically fetch the page title and rename the file when saving a new URL.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoFetchTitle)
                .onChange(async (value) => {
                    this.plugin.settings.autoFetchTitle = value;
                    await this.plugin.saveSettings();
                }));
    }
}

function isWebviewTag(el: unknown): el is WebviewTag {
    return (
        !!el &&
        typeof (el as WebviewTag).reload === "function" &&
        typeof (el as WebviewTag).goBack === "function" &&
        typeof (el as WebviewTag).goForward === "function"
    );
}

function isValidUrl(url: string): boolean {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

function extractTitleFromHtml(html: string): string | null {
    const headEnd = html.indexOf('</head>');
    const scope = headEnd >= 0 ? html.slice(0, headEnd + 7) : html;
    const pick = (key: string): string | null => {
        const re = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${key}["'][^>]*>`, 'i');
        const tag = re.exec(scope);
        if (!tag) return null;
        const c = /content\s*=\s*["']([^"']*)["']/i.exec(tag[0]);
        const v = c ? c[1].trim() : '';
        return v || null;
    };
    const og = pick('og:title') || pick('twitter:title');
    if (og) return og;
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(scope);
    const v = t ? t[1].trim() : '';
    return v || null;
}

function decodeHtmlEntities(s: string): string {
    const map: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
    return s.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (e) => map[e])
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function sanitizeFilename(s: string): string {
    return s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}