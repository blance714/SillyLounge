import type { Provider as PreactProvider } from 'preact';

declare module 'preact/compat' {
    export type Provider<T> = PreactProvider<T>;
}
