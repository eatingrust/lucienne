/** Verified in installed Krita 5.3.4's libkritaglobal and upstream kis_debug.cpp:
 * https://github.com/KDE/krita/blob/v6.0.4/libs/global/kis_debug.cpp
 * Enable scripting, native loading and fixed startup performance milestones; never inherit arbitrary rules. */
export const KRITA_SCRIPT_LOGGING_RULES = 'krita.scripting.debug=true;krita.plugins.debug=true;krita.performance.debug=true';
export const KRITA_BOOTSTRAP_MARKER = 'LUCIENNE_KRITA_BOOTSTRAP_V1';

export type KritaLoaderCode =
  | 'BOOTSTRAP_ENTERED' | 'PYTHON_PLUGIN_START' | 'PYTHON_INIT_START' | 'PYTHON_INTERPRETER_START' | 'PYTHON_LIBRARY_FAILED'
  | 'PYTHON_PATHS_FAILED' | 'PYKRITA_ENGINE_FAILED' | 'PYKRITA_MODULE_FAILED'
  | 'PYTHON_INIT_FAILED' | 'QT5_BINDINGS_MISSING' | 'PYKRITA_PLUGINS_READY'
  | 'BRIDGE_LOAD_ATTEMPT' | 'BRIDGE_LOAD_FAILED' | 'BRIDGE_IMPORT_FAILED'
  | 'BRIDGE_DISCOVERED_ENABLED' | 'BRIDGE_DISABLED' | 'BRIDGE_BROKEN'
  | 'NATIVE_PYKRITA_LOAD_ATTEMPT' | 'NATIVE_PYKRITA_LOAD_FAILED' | 'NATIVE_PYKRITA_FACTORY_RETURNED'
  | 'STARTUP_ADD_RESOURCE_TYPES_RETURNED' | 'STARTUP_LOAD_PLUGINS_RETURNED'
  | 'STARTUP_REGISTER_RESOURCES_RETURNED' | 'STARTUP_MAIN_WINDOW_RETURNED';
export interface KritaLoaderSnapshot {
  version: 1;
  diagnosticOnly: true;
  observations: Array<{ sequence: number; code: KritaLoaderCode }>;
  bytesSeen: number;
  overflowedLines: number;
  observationsTruncated: boolean;
}

/** These exact native phrases were read from the installed kritapykrita.so and
 * PyKrita.framework's krita/__init__.py, then checked against primary sources:
 * https://github.com/KDE/krita/blob/master/plugins/extensions/pykrita/plugin/plugin.cpp
 * https://github.com/KDE/krita/blob/master/plugins/extensions/pykrita/plugin/PythonPluginManager.cpp
 * https://github.com/KDE/krita/blob/master/plugins/extensions/pykrita/plugin/utilities.cpp
 * No arbitrary module name, path, exception, line or substring is returned. */
const fixedPhrases = new Map<string, KritaLoaderCode>([
  [KRITA_BOOTSTRAP_MARKER, 'BOOTSTRAP_ENTERED'],
  ['Loading Python plugin', 'PYTHON_PLUGIN_START'],
  ['Initializing Python interpreter', 'PYTHON_INTERPRETER_START'],
  ['Cannot load Python library', 'PYTHON_LIBRARY_FAILED'],
  ['Cannot set Python paths', 'PYTHON_PATHS_FAILED'],
  ['Cannot load built-in pykrita module', 'PYKRITA_ENGINE_FAILED'],
  ['Cannot load pykrita module', 'PYKRITA_MODULE_FAILED'],
  ['Unexpected error initializing python plugin.', 'PYTHON_INIT_FAILED'],
  ['Could not initialize Python interpreter', 'PYTHON_INIT_FAILED'],
  ['Python cannot find the Qt5 bindings.', 'QT5_BINDINGS_MISSING'],
  ['Loaded pykrita, now load plugins', 'PYKRITA_PLUGINS_READY'],
  ['Could not import lucienne_bridge', 'BRIDGE_IMPORT_FAILED'],
]);
// KisScopedPerformanceLogger emits on scope exit, including an unsuccessful return.
// https://github.com/KDE/krita/blob/v6.0.4/libs/global/KisScopedPerformanceLogger.h#L25
const startupStages = new Map<string, KritaLoaderCode>([
  ['KisApplication::addResourceTypes', 'STARTUP_ADD_RESOURCE_TYPES_RETURNED'],
  ['KisApplication::loadPlugins', 'STARTUP_LOAD_PLUGINS_RETURNED'],
  ['KisApplication::registerResources', 'STARTUP_REGISTER_RESOURCES_RETURNED'],
  ['KisMainWindow::KisMainWindow', 'STARTUP_MAIN_WINDOW_RETURNED'],
]);
function classify(line: string): KritaLoaderCode | undefined {
  const normalized = line.replace(/\r$/, '').trim();
  if (normalized.includes('\r')) return undefined;
  const stage = /^krita\.performance: (KisApplication::(?:addResourceTypes|loadPlugins|registerResources)|KisMainWindow::KisMainWindow): [0-9]+\.[0-9]{6} ms$/.exec(normalized);
  if (stage) return startupStages.get(stage[1]);
  // Qt's default prefix for dbgScript/warnScript, and QString's default quoting.
  // Other logging prefixes are deliberately not treated as trusted loader text.
  let text = normalized.replace(/^krita\.(?:scripting|plugins):\s*/, '');
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  const fixed = fixedPhrases.get(text);
  if (fixed) return fixed;
  // Exact installed native metadata Id. Filename/error/owner values are discarded.
  // A returned factory object does not prove Python initialized successfully.
  if (/^loading\s+"Python Plugin Manager"$/.test(text)) return 'NATIVE_PYKRITA_LOAD_ATTEMPT';
  if (/^Loading plugin\s+"[^"\r\n]*\/kritapykrita\.so"\s+failed,\s+.+$/.test(text)) return 'NATIVE_PYKRITA_LOAD_FAILED';
  if (/^Loaded plugin\s+"[^"\r\n]*\/kritapykrita\.so"\s+owner:\s+.+$/.test(text)) return 'NATIVE_PYKRITA_FACTORY_RETURNED';
  // Source appends PY_MAJOR_VERSION, a comma, and PY_MINOR_VERSION. Do not
  // retain the version or accept arbitrary text after this fixed milestone.
  if (/^Initializing Python plugin for Python [0-9]{1,2} , [0-9]{1,2}$/.test(text)) return 'PYTHON_INIT_START';
  if (/^Loading module:\s*(?:"lucienne_bridge"|lucienne_bridge)$/.test(text)) return 'BRIDGE_LOAD_ATTEMPT';
  if (/^Error loading plugin\s+(?:"lucienne_bridge"|lucienne_bridge)$/.test(text)) return 'BRIDGE_LOAD_FAILED';
  const discovered = /^Trying to load plugin\s+(?:"lucienne_bridge"|lucienne_bridge)\s*\. Enabled:\s*(true|false)\s*\. Broken:\s*(true|false)$/.exec(text);
  if (discovered) return discovered[2] === 'true' ? 'BRIDGE_BROKEN'
    : discovered[1] === 'true' ? 'BRIDGE_DISCOVERED_ENABLED' : 'BRIDGE_DISABLED';
  return undefined;
}

/** Streaming, lossy classifier. It owns at most 4096 raw line bytes and drops an
 * overlong line in its entirety, even if a known signature appears in its tail.
 * It keeps consuming after either budget is reached so the child's stderr never
 * blocks. The caller owns draining the pipe and calls finish() on end/close. */
export class KritaLoaderDiagnostics {
  private readonly line = Buffer.alloc(4096);
  private length = 0;
  private discardLine = false;
  private invalidLine = false;
  private bytesSeen = 0;
  private overflowedLines = 0;
  private observations: KritaLoaderSnapshot['observations'] = [];
  private observationsTruncated = false;
  private finished = false;

  consume(chunk: Uint8Array | string): void {
    if (this.finished) return;
    this.bytesSeen = Math.min(Number.MAX_SAFE_INTEGER,
      this.bytesSeen + (typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength));
    if (typeof chunk === 'string') {
      // Signatures are ASCII. Non-ASCII input invalidates only its own line and
      // never causes an unbounded UTF-8 conversion/allocation.
      for (let i = 0; i < chunk.length; i++) this.byte(chunk.charCodeAt(i));
    } else {
      for (const value of chunk) this.byte(value);
    }
  }
  finish(): void {
    if (this.finished) return;
    if (this.length || this.discardLine) this.flush();
    this.finished = true;
  }
  snapshot(): KritaLoaderSnapshot {
    return { version: 1, diagnosticOnly: true, observations: structuredClone(this.observations),
      bytesSeen: this.bytesSeen, overflowedLines: this.overflowedLines, observationsTruncated: this.observationsTruncated };
  }
  private byte(value: number): void {
    if (value === 10) { this.flush(); return; }
    if (this.discardLine) return;
    if (this.length === this.line.length) {
      this.line.fill(0); this.length = 0; this.discardLine = true;
      this.overflowedLines = Math.min(Number.MAX_SAFE_INTEGER, this.overflowedLines + 1);
      return;
    }
    if (value > 126 || (value < 32 && value !== 9 && value !== 13)) this.invalidLine = true;
    this.line[this.length++] = value <= 255 ? value : 255;
  }
  private flush(): void {
    if (!this.discardLine && !this.invalidLine) {
      const code = classify(this.line.subarray(0, this.length).toString('ascii'));
      if (code) {
        if (this.observations.length < 32) this.observations.push({ sequence: this.observations.length + 1, code });
        else this.observationsTruncated = true;
      }
    }
    this.line.fill(0, 0, this.length); this.length = 0; this.discardLine = false; this.invalidLine = false;
  }
}
