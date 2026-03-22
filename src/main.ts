import { Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, HeinibalPluginSettings, HeinibalSettingTab } from "./settings";
import { FileCardCanvasView, FILE_CARD_CANVAS_VIEW_TYPE } from "./view/FileCardCanvasView";
import type { CanvasData } from "./types";

export default class HeinibalPlugin extends Plugin {
	settings: HeinibalPluginSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(
			FILE_CARD_CANVAS_VIEW_TYPE,
			(leaf) => new FileCardCanvasView(leaf, this.app, this)
		);
		this.registerExtensions([FileCardCanvasView.HCANVAS_EXT], FILE_CARD_CANVAS_VIEW_TYPE);

		this.addRibbonIcon("layout-grid", "Create new file card canvas", () => {
			void this.createNewCanvasFile();
		});

		// this.addCommand({
		// 	id: "open-file-card-canvas",
		// 	name: "Open file card canvas",
		// 	callback: () => void this.activateView(),
		// });
		// this.addCommand({
		// 	id: "create-file-card-canvas",
		// 	name: "Create new file card canvas",
		// 	callback: () => void this.createNewCanvasFile(),
		// });

		this.addSettingTab(new HeinibalSettingTab(this.app, this));

		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			menu.addItem((item) => {
				item
					.setTitle("Create canvas file manager")
					.setIcon("layout-grid")
					.onClick(() => {
						const folderPath = this.resolveFolderPathForMenuTarget(file);
						void this.createNewCanvasFile(folderPath);
					});
			});
		}));
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<HeinibalPluginSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateView() {
		const leaves = this.app.workspace.getLeavesOfType(FILE_CARD_CANVAS_VIEW_TYPE);
		if (leaves.length > 0) {
			await this.app.workspace.revealLeaf(leaves[0]!);
		} else {
			await this.createNewCanvasFile();
		}
	}

	private get defaultCanvasFolder(): string {
		return (this.settings.defaultCanvasFolder ?? "").trim();
	}

	private resolveFolderPathForMenuTarget(file: TAbstractFile | null): string | null {
		if (!file) return this.defaultCanvasFolder || null;
		if (file instanceof TFolder) return file.path;
		if (file instanceof TFile) return file.parent?.path ?? null;
		return this.defaultCanvasFolder || null;
	}

	async createNewCanvasFile(folderPath?: string | null) {
		const baseFolder = folderPath ?? this.defaultCanvasFolder;
		const folder = (baseFolder ?? "").trim() || null;
		const path = this.getNextAvailableFilePath(folder, "Untitled Canvas", FileCardCanvasView.HCANVAS_EXT);
		const data: CanvasData = { nodes: [], edges: [] };
		const file = await this.app.vault.create(path, JSON.stringify(data, null, 2));
		const leaf = this.app.workspace.getLeaf("split", "vertical");
		await leaf.openFile(file);
	}

	private getNextAvailableFilePath(folder: string | null, base: string, ext: string): string {
		const normalizedFolder = folder?.trim() || "";
		const inFolder = this.app.vault.getFiles().filter((f) => {
			const parentPath = f.parent?.path ?? "";
			return parentPath === normalizedFolder;
		});
		const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const escapedExt = ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`^${escapedBase}(?:\\s*(\\d+))?\\.${escapedExt}$`, "i");
		const used = new Set<number>();
		for (const file of inFolder) {
			const match = file.name.match(pattern);
			if (!match) continue;
			if (!match[1]) {
				used.add(0);
				continue;
			}
			const index = Number(match[1]);
			if (Number.isFinite(index) && index >= 0) used.add(index);
		}
		let next = 0;
		while (used.has(next)) next++;

		for (let attempt = 0; attempt < 10000; attempt++) {
			const candidateName = next === 0 ? `${base}.${ext}` : `${base} ${next}.${ext}`;
			const candidatePath = normalizedFolder ? `${normalizedFolder}/${candidateName}` : candidateName;
			if (!this.app.vault.getAbstractFileByPath(candidatePath)) return candidatePath;
			next++;
		}
		const fallbackName = `${base}-${Date.now()}.${ext}`;
		return normalizedFolder ? `${normalizedFolder}/${fallbackName}` : fallbackName;
	}
}
