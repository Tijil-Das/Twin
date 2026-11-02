import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function App() {
  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--bg)",
        padding: "24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Card style={{ maxWidth: 480, width: "100%" }}>
        <CardHeader>
          <CardTitle style={{ fontSize: 20, fontWeight: 600 }}>Tether</CardTitle>
        </CardHeader>
        <CardContent>
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
            Google Drive sync — scaffold ready.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

