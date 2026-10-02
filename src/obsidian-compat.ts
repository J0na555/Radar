/**
 * `normalizePath` without importing `obsidian`.
 *
 * The real one lives in the Obsidian API, which `node --test` cannot load, and
 * the logic is small enough that copying it is cheaper than mocking the module
 * in every test. Collapses repeated slashes, drops a leading one, and drops a
 * trailing one, which is what Obsidian's vault paths look like.
 */
export function normalizePath(input: string): string {
	return input
		.replace(/([\\/])+/g, "/")
		.replace(/(^\/+|\/+$)/g, "")
		.replace(/ | /g, " ")
		.normalize("NFC");
}
