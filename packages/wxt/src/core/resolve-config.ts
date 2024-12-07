import { loadConfig } from 'c12';
import {
  InlineConfig,
  ResolvedConfig,
  UserConfig,
  ConfigEnv,
  UserManifestFn,
  UserManifest,
  ExtensionRunnerConfig,
  WxtResolvedUnimportOptions,
  Logger,
  WxtCommand,
  WxtModule,
  WxtModuleWithMetadata,
  ResolvedEslintrc,
} from '../types';
import path from 'node:path';
import { createFsCache } from './utils/cache';
import consola, { LogLevels } from 'consola';
import defu from 'defu';
import { NullablyRequired } from './utils/types';
import fs from 'fs-extra';
import { normalizePath } from './utils/paths';
import glob from 'fast-glob';
import { builtinModules } from '../builtin-modules';
import { getEslintVersion } from './utils/eslint';
import { safeStringToNumber } from './utils/number';
import { loadEnv } from './utils/env';
import { getPort } from 'get-port-please';

/**
 * Given an inline config, discover the config file if necessary, merge the results, resolve any
 * relative paths, and apply any defaults.
 *
 * Inline config always has priority over user config. Cli flags are passed as inline config if set.
 * If unset, undefined is passed in, letting this function decide default values.
 */
export async function resolveConfig(
  inlineConfig: InlineConfig,
  command: WxtCommand,
): Promise<ResolvedConfig> {
  // Load user config

  let userConfig: UserConfig = {};
  let userConfigMetadata: ResolvedConfig['userConfigMetadata'] | undefined;
  if (inlineConfig.configFile !== false) {
    const { config: loadedConfig, ...metadata } = await loadConfig<UserConfig>({
      configFile: inlineConfig.configFile,
      name: 'wxt',
      cwd: inlineConfig.root ?? process.cwd(),
      rcFile: false,
      jitiOptions: {
        esmResolve: true,
      },
    });
    if (inlineConfig.configFile && metadata.layers?.length === 0) {
      throw Error(`Config file "${inlineConfig.configFile}" not found`);
    }
    userConfig = loadedConfig ?? {};
    userConfigMetadata = metadata;
  }

  // Merge it into the inline config

  const mergedConfig = await mergeInlineConfig(inlineConfig, userConfig);

  // Apply defaults to make internal config.

  const debug = mergedConfig.debug ?? false;
  const logger = mergedConfig.logger ?? consola;
  if (debug) logger.level = LogLevels.debug;

  const browser = mergedConfig.browser ?? 'chrome';
  const manifestVersion =
    mergedConfig.manifestVersion ??
    (browser === 'firefox' || browser === 'safari' ? 2 : 3);
  const mode = mergedConfig.mode ?? COMMAND_MODES[command];
  const env: ConfigEnv = { browser, command, manifestVersion, mode };

  loadEnv(mode, browser); // Load any environment variables used below

  const root = path.resolve(
    inlineConfig.root ?? userConfig.root ?? process.cwd(),
  );
  const wxtDir = path.resolve(root, '.wxt');
  const wxtModuleDir = await resolveWxtModuleDir();
  const srcDir = path.resolve(root, mergedConfig.srcDir ?? root);
  const entrypointsDir = path.resolve(
    srcDir,
    mergedConfig.entrypointsDir ?? 'entrypoints',
  );
  const modulesDir = path.resolve(srcDir, mergedConfig.modulesDir ?? 'modules');
  if (await isDirMissing(entrypointsDir)) {
    logMissingDir(logger, 'Entrypoints', entrypointsDir);
  }
  const filterEntrypoints = mergedConfig.filterEntrypoints?.length
    ? new Set(mergedConfig.filterEntrypoints)
    : undefined;
  const publicDir = path.resolve(srcDir, mergedConfig.publicDir ?? 'public');
  const typesDir = path.resolve(wxtDir, 'types');
  const outBaseDir = path.resolve(root, mergedConfig.outDir ?? '.output');
  const modeSuffixes: Record<string, string | undefined> = {
    production: '',
    development: '-dev',
  };
  const outDirTemplate = (
    mergedConfig.outDirTemplate ?? `${browser}-mv${manifestVersion}`
  )
    // Resolve all variables in the template
    .replaceAll('{{browser}}', browser)
    .replaceAll('{{manifestVersion}}', manifestVersion.toString())
    .replaceAll('{{modeSuffix}}', modeSuffixes[mode] ?? `-${mode}`)
    .replaceAll('{{mode}}', mode)
    .replaceAll('{{command}}', command);

  const outDir = path.resolve(outBaseDir, outDirTemplate);
  const reloadCommand = mergedConfig.dev?.reloadCommand ?? 'Alt+R';

  const runnerConfig = await loadConfig<ExtensionRunnerConfig>({
    name: 'web-ext',
    cwd: root,
    globalRc: true,
    rcFile: '.webextrc',
    overrides: inlineConfig.runner,
    defaults: userConfig.runner,
  });
  // Make sure alias are absolute
  const alias = Object.fromEntries(
    Object.entries({
      ...mergedConfig.alias,
      '@': srcDir,
      '~': srcDir,
      '@@': root,
      '~~': root,
    }).map(([key, value]) => [key, path.resolve(root, value)]),
  );

  let devServerConfig: ResolvedConfig['dev']['server'];
  if (command === 'serve') {
    const hostname = mergedConfig.dev?.server?.hostname ?? 'localhost';
    let port = mergedConfig.dev?.server?.port;
    if (port == null || !isFinite(port)) {
      port = await getPort({
        port: 3000,
        portRange: [3001, 3010],
        // Passing host required for Mac, unsure of Windows/Linux
        host: hostname,
      });
    }
    devServerConfig = {
      port,
      hostname,
      watchDebounce: safeStringToNumber(process.env.WXT_WATCH_DEBOUNCE) ?? 800,
    };
  }

  const userModules = await resolveWxtUserModules(
    modulesDir,
    mergedConfig.modules,
  );
  const moduleOptions = userModules.reduce<Record<string, any>>(
    (map, module) => {
      if (module.configKey) {
        map[module.configKey] =
          // @ts-expect-error
          mergedConfig[module.configKey];
      }
      return map;
    },
    {},
  );

  const extensionApi = mergedConfig.extensionApi ?? 'webextension-polyfill';

  return {
    browser,
    command,
    debug,
    entrypointsDir,
    modulesDir,
    filterEntrypoints,
    env,
    fsCache: createFsCache(wxtDir),
    imports: await getUnimportOptions(
      wxtDir,
      srcDir,
      logger,
      extensionApi,
      mergedConfig,
    ),
    logger,
    manifest: await resolveManifestConfig(env, mergedConfig.manifest),
    manifestVersion,
    mode,
    outBaseDir,
    outDir,
    publicDir,
    wxtModuleDir,
    root,
    runnerConfig,
    srcDir,
    typesDir,
    wxtDir,
    zip: resolveZipConfig(root, browser, outBaseDir, mergedConfig),
    transformManifest: mergedConfig.transformManifest,
    analysis: resolveAnalysisConfig(root, mergedConfig),
    userConfigMetadata: userConfigMetadata ?? {},
    alias,
    extensionApi,
    entrypointLoader: mergedConfig.entrypointLoader ?? 'vite-node',
    experimental: defu(mergedConfig.experimental, {}),
    dev: {
      server: devServerConfig,
      reloadCommand,
    },
    hooks: mergedConfig.hooks ?? {},
    vite: mergedConfig.vite ?? (() => ({})),
    builtinModules,
    userModules,
    plugins: [],
    ...moduleOptions,
  };
}

async function resolveManifestConfig(
  env: ConfigEnv,
  manifest: UserManifest | Promise<UserManifest> | UserManifestFn | undefined,
): Promise<UserManifest> {
  return typeof manifest === 'function'
    ? await manifest(env)
    : await (manifest ?? {});
}

/**
 * Merge the inline config and user config. Inline config is given priority. Defaults are not applied here.
 */
async function mergeInlineConfig(
  inlineConfig: InlineConfig,
  userConfig: UserConfig,
): Promise<InlineConfig> {
  // Merge imports option
  const imports: InlineConfig['imports'] =
    inlineConfig.imports === false || userConfig.imports === false
      ? false
      : userConfig.imports == null && inlineConfig.imports == null
        ? undefined
        : defu(inlineConfig.imports ?? {}, userConfig.imports ?? {});

  // Merge manifest option
  const manifest: UserManifestFn = async (env) => {
    const user = await resolveManifestConfig(env, userConfig.manifest);
    const inline = await resolveManifestConfig(env, inlineConfig.manifest);
    return defu(inline, user);
  };

  // Merge transformManifest option
  const transformManifest: InlineConfig['transformManifest'] = (manifest) => {
    userConfig.transformManifest?.(manifest);
    inlineConfig.transformManifest?.(manifest);
  };

  const merged = defu(inlineConfig, userConfig);

  // Builders
  const builderConfig = await mergeBuilderConfig(
    merged.logger ?? consola,
    inlineConfig,
    userConfig,
  );

  return {
    ...merged,
    // Custom merge values
    transformManifest,
    imports,
    manifest,
    ...builderConfig,
  };
}

function resolveZipConfig(
  root: string,
  browser: string,
  outBaseDir: string,
  mergedConfig: InlineConfig,
): NullablyRequired<ResolvedConfig['zip']> {
  const downloadedPackagesDir = path.resolve(root, '.wxt/local_modules');
  return {
    name: undefined,
    sourcesTemplate: '{{name}}-{{version}}-sources.zip',
    artifactTemplate: '{{name}}-{{version}}-{{browser}}.zip',
    sourcesRoot: root,
    includeSources: [],
    compressionLevel: 9,
    ...mergedConfig.zip,
    zipSources:
      mergedConfig.zip?.zipSources ?? ['firefox', 'opera'].includes(browser),
    exclude: mergedConfig.zip?.exclude ?? [],
    excludeSources: [
      '**/node_modules',
      // WXT files
      '**/web-ext.config.ts',
      // Hidden files
      '**/.*',
      // Tests
      '**/__tests__/**',
      '**/*.+(test|spec).?(c|m)+(j|t)s?(x)',
      // Output directory
      `${path.relative(root, outBaseDir)}/**`,
      // From user
      ...(mergedConfig.zip?.excludeSources ?? []),
    ],
    downloadPackages: mergedConfig.zip?.downloadPackages ?? [],
    downloadedPackagesDir,
  };
}

function resolveAnalysisConfig(
  root: string,
  mergedConfig: InlineConfig,
): NullablyRequired<ResolvedConfig['analysis']> {
  const analysisOutputFile = path.resolve(
    root,
    mergedConfig.analysis?.outputFile ?? 'stats.html',
  );
  const analysisOutputDir = path.dirname(analysisOutputFile);
  const analysisOutputName = path.parse(analysisOutputFile).name;

  return {
    enabled: mergedConfig.analysis?.enabled ?? false,
    open: mergedConfig.analysis?.open ?? false,
    template: mergedConfig.analysis?.template ?? 'treemap',
    outputFile: analysisOutputFile,
    outputDir: analysisOutputDir,
    outputName: analysisOutputName,
    keepArtifacts: mergedConfig.analysis?.keepArtifacts ?? false,
  };
}

async function getUnimportOptions(
  wxtDir: string,
  srcDir: string,
  logger: Logger,
  extensionApi: ResolvedConfig['extensionApi'],
  config: InlineConfig,
): Promise<WxtResolvedUnimportOptions> {
  const disabled = config.imports === false;
  const eslintrc = await getUnimportEslintOptions(wxtDir, config.imports);
  const defaultOptions: WxtResolvedUnimportOptions = {
    // prettier-ignore
    imports: [
      { name: 'defineConfig',         from: 'wxt' },
      // wxt/client
      { name: 'useAppConfig',         from: 'wxt/client/useAppConfig' },
      { name: 'injectScript',         from: 'wxt/client/injectScript' },
      { name: 'ContentScriptContext', from: 'wxt/client/content-scripts/context' },
      { name: 'createIntegratedUi',   from: 'wxt/client/content-scripts/ui/createIntegratedUi' },
      { name: 'createShadowRootUi',   from: 'wxt/client/content-scripts/ui/createShadowRootUi' },
      { name: 'createIframeUi',       from: 'wxt/client/content-scripts/ui/createIframeUi' },
      // wxt/sandbox
      { name: 'defineAppConfig',      from: 'wxt/sandbox/defineAppConfig' },
      { name: 'defineBackground',     from: 'wxt/sandbox/defineBackground' },
      { name: 'defineContentScript',  from: 'wxt/sandbox/defineContentScript' },
      { name: 'defineUnlistedScript', from: 'wxt/sandbox/defineUnlistedScript' },
      { name: 'defineWxtPlugin',      from: 'wxt/sandbox/defineWxtPlugin' },
      { name: 'MatchPattern',         from: 'wxt/sandbox/match-patterns' },
      { name: 'InvalidMatchPattern',  from: 'wxt/sandbox/match-patterns' },
      // wxt/testing
      { name: 'fakeBrowser',          from: 'wxt/testing' },
    ],
    presets: [
      {
        package:
          extensionApi === 'chrome' ? 'wxt/browser/chrome' : 'wxt/browser',
      },
      { package: 'wxt/storage' },
    ],
    virtualImports: ['#imports'],
    debugLog: logger.debug,
    warn: logger.warn,
    dirsScanOptions: {
      cwd: srcDir,
    },
    eslintrc,
    dirs: ['components', 'composables', 'hooks', 'utils'],
    disabled,
  };

  return defu<WxtResolvedUnimportOptions, [WxtResolvedUnimportOptions]>(
    config.imports ?? {},
    defaultOptions,
  );
}

async function getUnimportEslintOptions(
  wxtDir: string,
  options: InlineConfig['imports'],
): Promise<ResolvedEslintrc> {
  const inlineEnabled =
    options === false ? false : (options?.eslintrc?.enabled ?? 'auto');

  let enabled: ResolvedEslintrc['enabled'];
  switch (inlineEnabled) {
    case 'auto':
      const version = await getEslintVersion();
      let major = parseInt(version[0]);
      if (isNaN(major)) enabled = false;
      if (major <= 8) enabled = 8;
      else if (major >= 9) enabled = 9;
      // NaN
      else enabled = false;
      break;
    case true:
      enabled = 8;
      break;
    default:
      enabled = inlineEnabled;
  }

  return {
    enabled,
    filePath: path.resolve(
      wxtDir,
      enabled === 9 ? 'eslint-auto-imports.mjs' : 'eslintrc-auto-import.json',
    ),
    globalsPropValue: true,
  };
}

/**
 * Returns the path to `node_modules/wxt`.
 */
async function resolveWxtModuleDir() {
  // TODO: Use this once we're fully running in ESM, see https://github.com/wxt-dev/wxt/issues/277
  // const url = import.meta.resolve('wxt', import.meta.url);
  // resolve() returns the "wxt/dist/index.mjs" file, not the package's root
  // directory, which we want to return from this function.
  // return path.resolve(fileURLToPath(url), '../..');

  const requireResolve =
    globalThis.require?.resolve ??
    (await import('node:module')).default.createRequire(import.meta.url)
      .resolve;

  // resolve() returns the "wxt/dist/index.mjs" file, not the package's root
  // directory, which we want to return from this function.
  return path.resolve(requireResolve('wxt'), '../..');
}

async function isDirMissing(dir: string) {
  return !(await fs.exists(dir));
}

function logMissingDir(logger: Logger, name: string, expected: string) {
  logger.warn(
    `${name} directory not found: ./${normalizePath(
      path.relative(process.cwd(), expected),
    )}`,
  );
}

/**
 * Map of `ConfigEnv` commands to their default modes.
 */
const COMMAND_MODES: Record<WxtCommand, string> = {
  build: 'production',
  serve: 'development',
};

export async function mergeBuilderConfig(
  logger: Logger,
  inlineConfig: InlineConfig,
  userConfig: UserConfig,
): Promise<Pick<InlineConfig, 'vite'>> {
  const vite = await import('vite').catch((err) => {
    logger.debug('Failed to import vite:', err);
  });
  if (vite) {
    return {
      vite: async (env) => {
        const resolvedInlineConfig = (await inlineConfig.vite?.(env)) ?? {};
        const resolvedUserConfig = (await userConfig.vite?.(env)) ?? {};
        return vite.mergeConfig(resolvedUserConfig, resolvedInlineConfig);
      },
    };
  }

  throw Error('Builder not found. Make sure vite is installed.');
}

export async function resolveWxtUserModules(
  modulesDir: string,
  modules: string[] = [],
): Promise<WxtModuleWithMetadata<any>[]> {
  // Resolve node_modules modules
  const npmModules = await Promise.all<WxtModuleWithMetadata<any>>(
    modules.map(async (moduleId) => {
      const mod: { default: WxtModule<any> } = await import(
        /* @vite-ignore */ moduleId
      );
      if (mod.default == null) {
        throw Error('Module missing default export: ' + moduleId);
      }
      return {
        ...mod.default,
        type: 'node_module',
        id: moduleId,
      };
    }),
  );

  // Resolve local file paths
  const localModulePaths = await glob(['*.[tj]s', '*/index.[tj]s'], {
    cwd: modulesDir,
    onlyFiles: true,
  }).catch(() => []);
  // Sort modules to ensure a consistent execution order
  localModulePaths.sort();
  const localModules = await Promise.all<WxtModuleWithMetadata<any>>(
    localModulePaths.map(async (file) => {
      const absolutePath = normalizePath(path.resolve(modulesDir, file));
      const { config } = await loadConfig<WxtModule<any>>({
        configFile: absolutePath,
        globalRc: false,
        rcFile: false,
        packageJson: false,
        envName: false,
        dotenv: false,
      });
      if (config == null)
        throw Error(
          `No config found for ${file}. Did you forget to add a default export?`,
        );
      // Add name based on filename
      config.name ??= file;
      return {
        ...config,
        type: 'local',
        id: absolutePath,
      };
    }),
  );
  return [...npmModules, ...localModules];
}
