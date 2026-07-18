import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

// Layer rules from ARCHITECTURE.md, enforced on source imports so violations
// fail the build instead of surviving as documentation-only promises:
//   1. Only the adapter (and the index.ts orchestrator) may import @st/* host
//      modules.
//   2. The adapter never reaches up into store or ui.
//   3. The store never reaches up into ui, and never into the shield.
//   4. UI components go through ui/hooks.ts and ui/actions.ts instead of
//      importing the store directly.
//   5. The shield stays dependency-free.
const IMPORT_PATTERN = /(?:^|\s)(?:import|export)[^'"]*?from\s*(['"])([^'"]+)\1|import\(\s*(['"])([^'"]+)\3\s*\)/gm;

function normalizeTarget(file, specifier) {
    if (!specifier.startsWith('.')) return specifier;
    const resolved = path.resolve(path.dirname(file), specifier);
    return path.relative(PROJECT_ROOT, resolved).split(path.sep).join('/');
}

function layerOf(relFile) {
    if (relFile === 'src/index.ts') return 'index';
    if (relFile.startsWith('src/adapter/')) return 'adapter';
    if (relFile.startsWith('src/store/')) return 'store';
    if (relFile.startsWith('src/shield/')) return 'shield';
    if (relFile.startsWith('src/ui/')) return 'ui';
    return 'other';
}

function checkImport(relFile, layer, target) {
    if (target.startsWith('@st/')) {
        if (layer !== 'adapter' && layer !== 'index') {
            return `只有 adapter 层和 src/index.ts 可以导入 @st/*，但 ${relFile} 导入了 ${target}`;
        }
        return null;
    }
    if (!target.startsWith('src/')) return null;
    const targetLayer = layerOf(target.endsWith('.js') || target.endsWith('.ts') || target.endsWith('.tsx')
        ? target.replace(/\.js$/, '.ts')
        : target);
    if (layer === 'adapter' && (targetLayer === 'store' || targetLayer === 'ui')) {
        return `adapter 层不得向上依赖 ${targetLayer} 层：${relFile} -> ${target}`;
    }
    if (layer === 'store' && (targetLayer === 'ui' || targetLayer === 'shield')) {
        return `store 层不得依赖 ${targetLayer} 层：${relFile} -> ${target}`;
    }
    if (layer === 'shield' && targetLayer !== 'shield') {
        return `shield 层必须保持零依赖：${relFile} -> ${target}`;
    }
    if (
        relFile.startsWith('src/ui/components/')
        && targetLayer === 'store'
    ) {
        return `UI 组件必须经由 ui/hooks.ts 或 ui/actions.ts 访问 store：${relFile} -> ${target}`;
    }
    return null;
}

async function main() {
    const problems = [];
    let fileCount = 0;
    const entries = await fs.readdir(SRC_DIR, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
        const absolute = path.join(entry.parentPath || entry.path, entry.name);
        const relFile = path.relative(PROJECT_ROOT, absolute).split(path.sep).join('/');
        const layer = layerOf(relFile);
        const source = await fs.readFile(absolute, 'utf8');
        fileCount += 1;
        for (const match of source.matchAll(IMPORT_PATTERN)) {
            const specifier = match[2] ?? match[4];
            if (!specifier) continue;
            const problem = checkImport(relFile, layer, normalizeTarget(absolute, specifier));
            if (problem) problems.push(problem);
        }
    }

    if (problems.length > 0) {
        console.error(`[check-boundaries] 分层校验失败（${problems.length} 个问题）：`);
        for (const problem of problems) console.error(`  - ${problem}`);
        process.exitCode = 1;
        return;
    }
    console.log(`[check-boundaries] OK：${fileCount} 个源文件全部符合分层规则。`);
}

await main();
