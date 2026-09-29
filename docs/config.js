// Viewer settings. Both can also be given in the URL: ?bot=SomeBot&telemetry=https://your-tunnel.example
window.VIEWER = {
  bot: "ClaudyEngine",   // Lichess account to mirror
  telemetry: "",         // optional: fixed base URL of the bot's public telemetry (web.public / web.public_port)
  // optional: gist where the bot publishes its current tunnel address (web.tunnel_gist); used when telemetry is ""
  telemetryGist: "7d1efa39a988e33bf9deaceb4489b896",
};
