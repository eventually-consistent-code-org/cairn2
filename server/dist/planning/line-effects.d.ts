/** The effects the re-run never runs a line with (#423). `touches-owner-checkout`
 *  is reported by the guard mid-run only, and a verify line runs on purpose. */
export declare const REFUSED_EFFECTS: ReadonlySet<string>;
/** One effect a git invocation on the line carries, and the words that carried it. */
export interface LineEffect {
    effect: string;
    /** The flag or word that caused it, as the classifier names it (`--force`, `+main`). */
    flag: string;
    /** The classifier's name for the row (`` `git push --force` ``). */
    what: string;
    /** The git invocation, wrappers peeled, as the line spelled it. */
    command: string;
}
export type Classified = {
    ok: true;
    effects: LineEffect[];
    git: string[];
} | {
    ok: false;
    reason: "classifier-unavailable" | "unclassifiable";
    detail: string;
};
/**
 * The plugin's hooks/scripts folder, resolved beside this module: from
 * server/dist/planning/ (and server/src/planning/ under the test runner)
 * three levels up, then hooks/scripts. Null when either module is absent
 * -- the published server package, or a layout this server does not know.
 */
export declare function hooksScriptsDir(): string | null;
/**
 * Classify one declared line. Never throws and never runs the line: a
 * child node that fails to start, dies, or prints something that is not
 * the driver's JSON reads as `classifier-unavailable`, with the reason.
 *
 * :param line: the declared verify line, verbatim
 * :param opts.hooksDir: where the hook modules are; null means "nowhere"
 *   (a test's stand-in for the published package), undefined resolves
 * :returns the effects found, the git invocations seen, or why neither could be read
 */
export declare function classifyLine(line: string, opts?: {
    hooksDir?: string | null;
}): Classified;
