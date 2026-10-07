/**
 * The score model's weights, as sliders in the settings tab.
 *
 * Its own module because these are the only settings that are a grid of nine
 * near-identical controls, and building them inline buried the rest of the tab.
 *
 * The log curve and the 25 points for a non-default branch were chosen by feel.
 * Exposing them does not make them right, it makes them arguable, which is the
 * point: a model nobody can inspect is a model nobody can correct.
 */
import { Setting } from "obsidian";
import { DEFAULT_WEIGHTS, WEIGHT_BOUNDS, WEIGHT_KEYS, WEIGHT_LABELS } from "./rank";
import type { PluginSettings, ScoreWeights } from "./types";

/** One line saying what a weight is now and what it starts at. */
function describeWeight(key: keyof ScoreWeights, value: number): string {
	const current = key.endsWith("Days") ? `${value} days` : `${value} points`;
	const isDefault = value === DEFAULT_WEIGHTS[key];
	return isDefault ? `${current}.` : `${current}, default ${DEFAULT_WEIGHTS[key]}.`;
}

/**
 * Draw one slider per weight.
 *
 * `settings.weights` is mutated in place and saved, so the running panel picks up
 * the new numbers on its next scan without a reload.
 */
export function renderWeightSettings(
	container: HTMLElement,
	settings: PluginSettings,
	save: () => Promise<void>,
): void {
	// A container of its own, because Reset redraws and the caller only clears the
	// settings tab as a whole.
	const host = container.createDiv({ cls: "gd-weights" });

	const draw = (): void => {
		host.empty();

		for (const key of WEIGHT_KEYS) {
			const bounds = WEIGHT_BOUNDS[key];
			let row: Setting;
			row = new Setting(host)
				.setName(WEIGHT_LABELS[key])
				.setDesc(describeWeight(key, settings.weights[key]))
				.addSlider((slider) =>
					slider
						.setLimits(bounds.min, bounds.max, bounds.step)
						.setValue(settings.weights[key])
						.onChange(async (value) => {
							const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
							settings.weights = { ...settings.weights, [key]: clamped };
							row.setDesc(describeWeight(key, clamped));
							await save();
						}),
				);
		}

		new Setting(host)
			.setName("Reset weights")
			.setDesc("Put every weight back to the values this plugin shipped with.")
			.addButton((button) =>
				button.setButtonText("Reset").onClick(async () => {
					settings.weights = { ...DEFAULT_WEIGHTS };
					await save();
					// Redrawn, so every slider handle returns to its own default and
					// not just the one that was moved.
					draw();
				}),
			);
	};

	draw();
}