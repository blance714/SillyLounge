// Keep the runtime Zod boundary explicit. Exporting Zod's full `z` namespace as
// a library entry forces Rollup to retain every public schema helper. This small
// facade preserves the authored `z.*` API while bundling only what schema.ts
// actually uses. The test suite keeps this list in sync with that source file.
import {
    array,
    boolean,
    catch as catchSchema,
    catchall,
    number,
    object,
    optional,
    pipe,
    string,
    transform,
    union,
    unknown,
} from 'zod/mini';

export const z = Object.freeze({
    array,
    boolean,
    catch: catchSchema,
    catchall,
    number,
    object,
    optional,
    pipe,
    string,
    transform,
    union,
    unknown,
});
