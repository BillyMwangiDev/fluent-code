/**
 * How another program — a CLI's hook runner, an agent's shell, an MCP client — runs one of Fluent's
 * own compiled scripts.
 *
 * From a checkout that is plain `node`. Inside the packaged fluentd it cannot be: there is no `dist/`
 * on disk (the scripts live in the binary's snapshot, at `/snapshot/...` paths only the binary can
 * read) and no guarantee Node is installed at all. pkg runs a snapshot script, instead of the daemon,
 * when its binary is started with PKG_EXECPATH set to the binary's own path.
 */
export function packagedExecutable(): string | undefined {
  return (process as NodeJS.Process & {pkg?: unknown}).pkg ? process.execPath : undefined;
}

/** Shell command prefix that precedes a script path: `node`, or the packaged binary told to run it. */
export function scriptRunner() {
  const executable = packagedExecutable();
  return executable ? `PKG_EXECPATH=${JSON.stringify(executable)} ${JSON.stringify(executable)}` : 'node';
}
