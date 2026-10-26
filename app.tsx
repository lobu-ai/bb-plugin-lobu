// bb-plugin-lobu — frontend entry. Compiled by `bb plugin build`; React and
// the SDK come from the bb app at load time.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DashboardPage, NeedsYouStrip } from "@/components/dashboard";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dashboard",
    title: "Lobu",
    icon: "lobu/lobu",
    path: "dashboard",
    component: DashboardPage,
  });
  app.slots.homepageSection({
    id: "needs-you",
    title: "Lobu",
    component: NeedsYouStrip,
  });
});
