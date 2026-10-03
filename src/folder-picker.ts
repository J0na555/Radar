/**
 * The options for the notes-folder dropdown.
 *
 * Separate from the Obsidian call that lists them, because the decision of what belongs in the
 * list is the part worth testing and the part with a bug in it: the first version of this wrote
 * a hardcoded folder nobody had asked for, created it on first scan, and put a stranger's
 * dashboard in a stranger's vault. The list is built from what the vault actually contains.
 *
 * No `obsidian` import, so `node --test` loads this directly.
 */
import { normalizePath } from "./obsidian-compat.ts";

/** One row of the dropdown. `value` is what gets saved. */
export interface FolderChoice {
	value: string;
	label: string;
}

/**
 * Every folder in the vault, plus the vault root, plus the current setting even when no such
 * folder exists.
 *
 * That last one is the awkward case worth handling rather than papering over. A setting pointing
 * at a folder somebody deleted is a normal state -- they deleted it in the file manager -- and a
 * dropdown that silently omits the current value shows the wrong folder as selected, so the next
 * save of an unrelated setting writes a different folder. It is listed with its real value and
 * labelled as missing, which is also the truth: the next scan creates it.
 */
export function folderChoices(current: string, folders: readonly string[]): FolderChoice[] {
	const root: FolderChoice = { value: "", label: "Vault root" };
	const values = new Set<string>();
	for (const folder of folders) {
		const value = normalizePath(folder);
		if (value !== "" && value !== ".") values.add(value);
	}

	const currentValue = normalizePath(current);
	const existsAlready = folders.map(normalizePath).includes(currentValue);
	if (currentValue !== "" && !existsAlready) {
		values.add(currentValue);
		return [
			{ value: currentValue, label: `${currentValue} (missing, will be created)` },
			...sorted(values),
			root,
		];
	}

	return [...sorted(values), root];
}

/** Alphabetical, so the list does not reshuffle every time a folder is created. */
function sorted(values: ReadonlySet<string>): FolderChoice[] {
	return [...values]
		.sort((a, b) => a.localeCompare(b))
		.map((value) => ({ value, label: value }));
}