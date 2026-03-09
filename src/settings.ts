import {App, Plugin, PluginSettingTab, Setting} from "obsidian";
import type { CanvasData } from "./types";

export interface MyPluginSettings {
	mySetting: string;
	defaultCanvasFolder?: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
	defaultCanvasFolder: "",
};

export class SampleSettingTab extends PluginSettingTab {
	plugin: Plugin & { settings: MyPluginSettings; saveSettings: () => Promise<void> };

	constructor(app: App, plugin: Plugin & { settings: MyPluginSettings; saveSettings: () => Promise<void> }) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Default canvas folder")
			.setDesc("Folder for new .hcanvas files (leave empty for vault root)")
			.addText((text) =>
				text
					.setPlaceholder("e.g. Canvases")
					.setValue(this.plugin.settings.defaultCanvasFolder ?? "")
					.onChange(async (value) => {
						this.plugin.settings.defaultCanvasFolder = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
