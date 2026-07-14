const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = [
    // Base recommended JS rules — applies to every file.
    js.configs.recommended,

    // TypeScript-specific rules for our source and tests. We use the type-checked
    // presets so rules like no-floating-promises can rely on inferred types.
    ...tseslint.configs.recommendedTypeChecked.map((c) => ({
        ...c,
        files: ['**/*.ts'],
    })),

    // Project-wide options and rule overrides.
    {
        files: ['**/*.ts'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            parserOptions: {
                projectService: true,
                tsconfigRootDir: __dirname,
            },
            globals: {
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                process: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                Buffer: 'readonly',
                NodeJS: 'readonly',
            },
        },
        rules: {
            // Style / correctness — kept from the previous JS-only config.
            'no-unused-vars': 'off', // superseded by @typescript-eslint/no-unused-vars
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-var': 'warn',
            eqeqeq: ['warn', 'always', { null: 'ignore' }],

            // The plugin's type-checked preset is quite loud on this codebase — soften the
            // most-noisy rules to warnings so the initial pass is manageable. Individual
            // remaining warnings are addressed incrementally.
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/restrict-template-expressions': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/no-misused-promises': 'off',
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/unbound-method': 'off',
            '@typescript-eslint/no-floating-promises': 'warn',
            // CharacteristicValue is a union (number | boolean | string) — the type includes
            // `object` too, but HAP never delivers a plain object. Formatting via template
            // literals is safe here.
            '@typescript-eslint/no-base-to-string': 'off',
        },
    },

    // The node:test framework uses describe()/it() calls that intentionally return
    // promises without awaiting them; suppress no-floating-promises there.
    {
        files: ['test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/no-unnecessary-type-assertion': 'off',
        },
    },

    // Ignore build output and vendored files
    {
        ignores: ['dist/**', 'node_modules/**', 'test.js'],
    },
];
