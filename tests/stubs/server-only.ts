// Next resolves "server-only" itself and fails the build when a client module reaches it. Under
// vitest there is no client graph to protect, so the import resolves to this empty module.
export {};
