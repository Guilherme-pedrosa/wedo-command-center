const RELOAD_KEY = "chunk-reload-attempt";

/**
 * Envolve um import() dinâmico: se o chunk falhar (deploy novo invalidou o hash
 * do arquivo em cache), recarrega a página uma única vez para buscar o manifesto atual.
 */
export function lazyImportWithRetry<T>(factory: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      const mod = await factory();
      window.sessionStorage.removeItem(RELOAD_KEY);
      return mod;
    } catch (error) {
      const alreadyReloaded = window.sessionStorage.getItem(RELOAD_KEY) === "1";
      if (!alreadyReloaded) {
        window.sessionStorage.setItem(RELOAD_KEY, "1");
        window.location.reload();
        // Evita renderizar erro enquanto o reload acontece
        return new Promise<T>(() => {});
      }
      throw error;
    }
  };
}
