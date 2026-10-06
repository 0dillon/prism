import type { Metadata } from "next";
import { DemoPlayer } from "./DemoPlayer";

export const metadata: Metadata = {
  title: "Demo",
  description: "Try one sample lesson as different learners, with no account.",
};

export default function DemoPage() {
  return <DemoPlayer />;
}
