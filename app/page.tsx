import Shell from "./Shell";
import { INSTANCE_NAME } from "@/lib/config";

/**
 * The instance name is handed down as a prop, unlike PUBLIC_BASE_URL and the
 * feature flags which are injected onto `window`. It is rendered in the
 * titlebar, so the server's own HTML has to carry it: a client-side read off
 * `window` would render the breadcrumb one way on the server and another on
 * hydration, which React reports as a mismatch and repaints.
 */
export default function Page() {
  return <Shell instanceName={INSTANCE_NAME} />;
}
