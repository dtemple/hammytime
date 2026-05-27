import { Suspense } from "react";
import { StravaConnectedContent } from "./content";

export default function StravaConnectedPage() {
  return (
    <Suspense>
      <StravaConnectedContent />
    </Suspense>
  );
}
