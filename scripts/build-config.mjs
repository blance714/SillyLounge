export const buildOptions = {
    entryPoints: ['ui/app.tsx'],
    outfile: 'dist/root-app.mjs',
    bundle: true,
    format: 'esm',
    target: 'es2020',
    sourcemap: true,
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    alias: {
        react: 'preact/compat',
        'react-dom': 'preact/compat',
        'react-dom/client': 'preact/compat/client',
        'react/jsx-runtime': 'preact/compat/jsx-runtime',
        'react/jsx-dev-runtime': 'preact/compat/jsx-dev-runtime',
    },
    external: [
        '../shield/*',
        '../store/*',
    ],
    logLevel: 'info',
};
