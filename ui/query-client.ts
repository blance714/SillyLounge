import { QueryClient } from '@tanstack/react-query';

export const chatuiQueryClient = new QueryClient({
    defaultOptions: {
        queries: {
            gcTime: 5 * 60 * 1000,
            refetchOnReconnect: false,
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 1_000,
        },
    },
});

export function resetChatuiQueryClient(): void {
    void chatuiQueryClient.cancelQueries();
    chatuiQueryClient.clear();
}
