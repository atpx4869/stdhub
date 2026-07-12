/*
 * Runtime configuration for browser and Capacitor builds.
 * Keep apiBase empty for the normal same-origin web deployment.
 * The iOS packaging step replaces this value with the HTTPS API origin.
 */
window.STDHUB_RUNTIME_CONFIG = window.STDHUB_RUNTIME_CONFIG || {
  apiBase: '',
};
