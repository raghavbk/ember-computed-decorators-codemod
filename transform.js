'use strict';

const fs = require("fs");

const LOG_FILE = "ember-computed-decorators-codemod.tmp." + process.pid;
const ERROR_WARNING = 1;
const MISSING_GLOBAL_WARNING = 2;

const OPTS = {
  quote: 'single'
};

module.exports = transform;

/**
 * This is the entry point for this jscodeshift transform.
 * It scans JavaScript files that use the Ember global and updates
 * them to use the module syntax from the proposed new RFC.
 */
function transform(file, api /*, options*/ ) {
  let source = file.source;

  const lineTerminator = source.indexOf('\r\n') > -1 ? '\r\n' : '\n';

  let j = api.jscodeshift;

  let root = j(source);

  // Track any use of `Ember.*` that isn't accounted for in the mapping. We'll
  // use this at the end to generate a report.
  let warnings = [];

  let pendingGlobals = {};

  try {
    // Discover existing module imports, if any, in the file. If the user has
    // already imported one or more exports that we rewrite a global with, we
    // won't import them again. We also try to be smart about not adding multiple
    // import statements to import from the same module, condensing default
    // exports and named exports into one line if necessary.
    let registry = findExistingModules(root);

    let firstComputedDecoratorImport = root.find(j.ImportDeclaration, {
      source: { value: 'ember-computed-decorators' }
    });

    if (firstComputedDecoratorImport.__paths.length == 0) {
      firstComputedDecoratorImport = root.find(j.ImportDeclaration, {
        source: { value: 'ember-computed-decorators/ember-data' }
      });
    }

    // ember-computed-decorators not used in this file
    if (firstComputedDecoratorImport.__paths.length == 0) {
      return source
    }

    const computedDecoratorImports = registry.modules
      .filter(mod => mod.source === 'ember-computed-decorators')
      .map(mod => mod.imported);

    const computedDataDecoratorImports = registry.modules
      .filter(mod => mod.source === 'ember-computed-decorators/ember-data')
      .map(mod => mod.imported);


    let importsToAdd = {}

    function addNewImport(source, name) {
      if (!importsToAdd[source]) {
        importsToAdd[source] = []
      }
      importsToAdd[source].push(name)
    }

    computedDecoratorImports.forEach(imported => {
      let added = false
      if (imported === 'default') {
        addNewImport('@ember/object', 'computed')
      } else {
        addNewImport('@ember/object/computed', imported)
      }
    })

    computedDataDecoratorImports.sort()
      .forEach(imported => {
        addNewImport('@ember-decorators/data', imported)
      })

    Object.keys(importsToAdd)
      .sort()
      .forEach(source => {
        const local = importsToAdd[source]
        const imported = local.map(v =>
          j.importSpecifier(j.identifier(v), j.identifier(v))
        )
        const importStatement = j.importDeclaration(imported, j.literal(source))
        firstComputedDecoratorImport.insertBefore(importStatement)
      })

    let sources = [
      'ember-computed-decorators',
      'ember-computed-decorators/ember-data'
    ]

    sources.forEach(v => {
      root.find(j.ImportDeclaration, { source: { value: v } })
        .remove()
    })

    // jscodeshift is not so great about giving us control over the resulting whitespace.
    // We'll use a regular expression to try to improve the situation (courtesy of @rwjblue).
    source = beautifyImports(root.toSource(Object.assign({}, OPTS, {
      lineTerminator: lineTerminator
    })));
  } catch (e) {
    if (process.env.EMBER_MODULES_CODEMOD) {
      warnings.push([ERROR_WARNING, file.path, source, e.stack]);
    }

    throw e;
  } finally {
    // If there were modules that we didn't know about, write them to a log file.
    // We only do this if invoked via the CLI tool, not jscodeshift directly,
    // because jscodeshift doesn't give us a cleanup hook when everything is done
    // to parse these files. (This is what the environment variable is checking.)
    if (warnings.length && process.env.EMBER_MODULES_CODEMOD) {
      warnings.forEach(warning => {
        fs.appendFileSync(LOG_FILE, JSON.stringify(warning) + "\n");
      });
    }
  }

  return source;

  function findExistingModules(root) {
    let registry = new ModuleRegistry();

    root
      .find(j.ImportDeclaration)
      .forEach(mod => {
        let node = mod.node;
        let source = node.source.value;

        node.specifiers.forEach(spec => {
          let isDefault = j.ImportDefaultSpecifier.check(spec);

          // Some cases like `import * as bar from "foo"` have neither a
          // default nor a named export, which we don't currently handle.
          let imported = isDefault ? "default" :
            (spec.imported ? spec.imported.name : null);

          if (!imported) { return; }

          if (!registry.find(source, imported)) {
            let mod = registry.create(source, imported, spec.local.name);
            mod.node = node;
          }
        });
      });

    return registry;
  }

  function beautifyImports(source) {
    return source.replace(/\bimport.+from/g, (importStatement) => {
      let openCurly = importStatement.indexOf('{');

      // leave default only imports alone
      if (openCurly === -1) {
        return importStatement;
      }

      if (importStatement.length > 50) {
        // if the segment is > 50 chars make it multi-line
        let result = importStatement.slice(0, openCurly + 1);
        let named = importStatement
          .slice(openCurly + 1, -6)
          .split(',')
          .map(name => `\n  ${name.trim()}`);

        return result + named.join(',') + '\n} from';
      } else {
        // if the segment is < 50 chars just make sure it has proper spacing
        return importStatement
          .replace(/,\s*/g, ', ') // ensure there is a space after commas
          .replace(/\{\s*/, '{ ')
          .replace(/\s*\}/, ' }');
      }
    });
  }
}

class ModuleRegistry {
  constructor() {
    this.bySource = {};
    this.modules = [];
  }

  find(source, imported) {
    let byImported = this.bySource[source];

    if (!byImported) {
      byImported = this.bySource[source] = {};
    }

    return byImported[imported] || null;
  }

  create(source, imported, local) {
    if (this.find(source, imported)) {
      throw new Error(`Module { ${source}, ${imported} } already exists.`);
    }

    let byImported = this.bySource[source];
    if (!byImported) {
      byImported = this.bySource[source] = {};
    }

    let mod = new Module(source, imported, local);
    byImported[imported] = mod;
    this.modules.push(mod);

    return mod;
  }

  get(source, imported, local) {
    let mod = this.find(source, imported, local);
    if (!mod) {
      mod = this.create(source, imported, local);
    }

    return mod;
  }
}

class Module {
  constructor(source, imported, local) {
    this.source = source;
    this.imported = imported;
    this.local = local;
    this.node = null;
  }
}
