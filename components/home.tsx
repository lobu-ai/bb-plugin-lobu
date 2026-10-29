// The New thread screen's Lobu section: the setup card until bb is connected,
// then what a new thread in the project picked in the composer starts with.
import { useComposers } from "@get-bb/plugin-sdk/app";
import { ProjectBrief } from "@/components/memory";
import { isConnected, SetupCard, useSetupStatus } from "@/components/setup";

/**
 * The project the New thread composer will create the thread in. bb 0.46
 * leaves the section's own `projectId` prop null, so this reads the
 * composer's scope, which follows its project picker.
 */
function useNewThreadProject(): string | null {
  for (const { scope } of useComposers()) if (scope.kind === "new-thread") return scope.projectId;
  return null;
}

export function LobuHome() {
  const { status, reload } = useSetupStatus();
  const projectId = useNewThreadProject();
  if (status === null) return null;
  // Threads start with the project's brief even while Lobu is not connected, so it shows here too.
  return (
    <div className="space-y-3">
      {isConnected(status) ? null : <SetupCard status={status} reload={reload} />}
      {projectId === null ? null : <ProjectBrief projectId={projectId} />}
    </div>
  );
}
