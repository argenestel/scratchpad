# Cloudflare Tunnel

1. In the Cloudflare Zero Trust dashboard, go to **Networks > Tunnels** and
   create a remotely managed Cloudflare Tunnel. Copy its tunnel token from the
   connector installation command (the value after `--token`). See Cloudflare's
   [token instructions](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/).
2. Add a public hostname, such as `notes.example.com`, whose service is
   `http://scratchpad:3000`. Both services share the Compose network; `localhost`
   inside the tunnel container would refer to that container itself.
3. Copy `.env.example` to `.env` if needed. Put the token in `.env` as
   `TUNNEL_TOKEN` and set `APP_URL=https://notes.example.com` to your public HTTPS
   URL so session cookies get the Secure flag and redirects use the correct URL.
4. Start from the repository root:

   ```sh
   docker compose --profile tunnel up -d
   ```

   Use `make tunnel` to build the app image as well.

The tunnel publishes no host ports. The app and callback host ports remain bound
to `127.0.0.1`; the tunnel reaches the app over the Compose network.

As described in [README.md](../README.md#sign-in) and
[CONTRACT.md](../CONTRACT.md), ChatGPT browser OAuth has the fixed redirect
`http://localhost:1455/auth/callback`. With this deployment, browser OAuth only
works when the browser is on the same machine as the server. Remote users should
use **device code** sign-in, which works from anywhere and needs no callback port
exposed through Cloudflare.

For a private instance, put a Cloudflare Access application policy in front of
the hostname to restrict who can reach it. See Cloudflare's
[self-hosted application guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).
