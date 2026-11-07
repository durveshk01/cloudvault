import ShareView from "./ShareView";

export function generateStaticParams() {
  return [{ token: "preview" }];
}

export default function Page() {
  return <ShareView />;
}
