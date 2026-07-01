export function formatTimestamp(value: string | number | null): string {
    if (value === null || value === '') return '';
    if (typeof value === 'string' && Number.isNaN(Number(value))) return value;

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(duration: string | number | null): string {
    const ms = Number(duration);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds}s`;
}

export function formatBytes(value: number | null): string {
    if (value === null || value < 0) return '';

    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    const precision = unitIndex === 0 || size >= 10 ? 0 : 1;
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
}
