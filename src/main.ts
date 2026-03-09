import { Plugin } from "obsidian";
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

		this.addCommand({
			// id: "open-file-card-canvas",
			// name: "Open file card canvas",
			callback: () => void this.activateView(),
		});
		this.addCommand({
			// id: "create-file-card-canvas",
			// name: "Create new file card canvas",
			callback: () => void this.createNewCanvasFile(),
		});

		this.addSettingTab(new HeinibalSettingTab(this.app, this));
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

	async createNewCanvasFile() {
		const folder = this.defaultCanvasFolder || null;
		const base = "Untitled Canvas";
		let name = `${base}.${FileCardCanvasView.HCANVAS_EXT}`;
		let n = 0;
		while (this.app.vault.getAbstractFileByPath(folder ? `${folder}/${name}` : name)) {
			n++;
			name = `${base} ${n}.${FileCardCanvasView.HCANVAS_EXT}`;
		}
		const path = folder ? `${folder}/${name}` : name;
		const data: CanvasData = { nodes: [], edges: [] };
		const file = await this.app.vault.create(path, JSON.stringify(data, null, 2));
		const leaf = this.app.workspace.getLeaf("split", "vertical");
		await leaf.openFile(file);
	}
}
