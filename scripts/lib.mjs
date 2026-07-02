import fs from 'node:fs/promises';
import path from 'node:path';

export function posixPath(value) {
    return value.split(path.sep).join('/');
}

export async function walk(dir, visit) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walk(fullPath, visit);
        } else if (entry.isFile()) {
            await visit(fullPath, entry);
        }
    }
}
