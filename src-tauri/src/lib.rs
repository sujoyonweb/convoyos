use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashMap;
use std::env;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const TURBO_PORT: u16 = 53317;
const MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 167);

#[derive(Clone, Serialize, Deserialize, Debug)]
struct LanPeer {
    id: String,
    name: String,
    ip: String,
    port: u16,
    os: String,
    #[serde(rename = "type")]
    device_type: String,
    last_seen: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
struct IncomingFileNotice {
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "fileSize")]
    file_size: u64,
    sender: String,
}

#[derive(Clone, Serialize, Debug)]
struct CliStagedItem {
    id: String,
    name: String,
    path: PathBuf,
}

struct AppState {
    node_id: Mutex<String>,
    device_name: Mutex<String>,
    os_name: Mutex<String>,
    device_type: Mutex<String>,
    lan_ip: String,
    downloads_dir: PathBuf,
    peers: Mutex<HashMap<String, LanPeer>>,
    incoming_notices: Mutex<Vec<IncomingFileNotice>>,
    cli_files: Mutex<Vec<CliStagedItem>>,
}

fn now_sec() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs()
}

fn detect_lan_ipv4() -> String {
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(local_addr) = sock.local_addr() {
                return local_addr.ip().to_string();
            }
        }
    }
    "127.0.0.1".to_string()
}

fn resolve_downloads_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = env::var("USERPROFILE") {
            let p = PathBuf::from(profile).join("Downloads");
            if p.exists() {
                return p;
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let android_dl = PathBuf::from("/storage/emulated/0/Download");
        if android_dl.exists() {
            return android_dl;
        }
        if let Ok(home) = env::var("HOME") {
            let p = PathBuf::from(home).join("Downloads");
            if p.exists() {
                return p;
            }
        }
    }
    env::temp_dir()
}

fn get_unique_file_path(dir: &Path, raw_name: &str) -> (PathBuf, String) {
    let safe_name = Path::new(raw_name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("received_file.bin");

    let candidate = dir.join(safe_name);
    if !candidate.exists() {
        return (candidate, safe_name.to_string());
    }

    let stem = Path::new(safe_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = Path::new(safe_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    for i in 1..10000 {
        let numbered = if ext.is_empty() {
            format!("{} ({})", stem, i)
        } else {
            format!("{} ({}).{}", stem, i, ext)
        };
        let p = dir.join(&numbered);
        if !p.exists() {
            return (p, numbered);
        }
    }
    (candidate, safe_name.to_string())
}

fn url_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let mut chars = input.as_bytes().iter().copied();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let h1 = chars.next();
            let h2 = chars.next();
            if let (Some(c1), Some(c2)) = (h1, h2) {
                let hex = [c1, c2];
                if let Ok(s) = std::str::from_utf8(&hex) {
                    if let Ok(val) = u8::from_str_radix(s, 16) {
                        bytes.push(val);
                        continue;
                    }
                }
            }
        } else if b == b'+' {
            bytes.push(b' ');
            continue;
        }
        bytes.push(b);
    }
    String::from_utf8_lossy(&bytes).to_string()
}

fn parse_query_params(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            map.insert(url_decode(k), url_decode(v));
        }
    }
    map
}

// Embedded Web Assets so Zero-Install Mobile Hotspot Hosting works inside Android .apk & Windows .exe
fn get_embedded_web_asset(rel_path: &str) -> Option<(&'static [u8], &'static str)> {
    match rel_path {
        "index.html" => Some((include_bytes!("../../index.html"), "text/html; charset=utf-8")),
        "manifest.json" => Some((include_bytes!("../../manifest.json"), "application/json; charset=utf-8")),
        "sw.js" => Some((include_bytes!("../../sw.js"), "application/javascript; charset=utf-8")),
        "css/variables.css" => Some((include_bytes!("../../css/variables.css"), "text/css; charset=utf-8")),
        "css/reset.css" => Some((include_bytes!("../../css/reset.css"), "text/css; charset=utf-8")),
        "css/main.css" => Some((include_bytes!("../../css/main.css"), "text/css; charset=utf-8")),
        "css/components.css" => Some((include_bytes!("../../css/components.css"), "text/css; charset=utf-8")),
        "js/qr.js" => Some((include_bytes!("../../js/qr.js"), "application/javascript; charset=utf-8")),
        "js/storage.js" => Some((include_bytes!("../../js/storage.js"), "application/javascript; charset=utf-8")),
        "js/dragdrop.js" => Some((include_bytes!("../../js/dragdrop.js"), "application/javascript; charset=utf-8")),
        "js/discovery.js" => Some((include_bytes!("../../js/discovery.js"), "application/javascript; charset=utf-8")),
        "js/transfer.js" => Some((include_bytes!("../../js/transfer.js"), "application/javascript; charset=utf-8")),
        "js/app.js" => Some((include_bytes!("../../js/app.js"), "application/javascript; charset=utf-8")),
        "js/native-turbo.js" => Some((include_bytes!("../../js/native-turbo.js"), "application/javascript; charset=utf-8")),
        "assets/favicon.svg" => Some((include_bytes!("../../assets/favicon.svg"), "image/svg+xml")),
        _ => None,
    }
}

fn spawn_udp_multicast_radar(state: Arc<AppState>) {
    let state_tx = state.clone();
    std::thread::spawn(move || {
        if let Ok(tx_sock) = UdpSocket::bind("0.0.0.0:0") {
            let _ = tx_sock.set_broadcast(true);
            let _ = tx_sock.set_multicast_loop_v4(false);
            loop {
                let id = state_tx.node_id.lock().unwrap().clone();
                let name = state_tx.device_name.lock().unwrap().clone();
                let os = state_tx.os_name.lock().unwrap().clone();
                let dtype = state_tx.device_type.lock().unwrap().clone();

                let beacon = serde_json::json!({
                    "id": id,
                    "name": name,
                    "ip": state_tx.lan_ip,
                    "port": TURBO_PORT,
                    "os": os,
                    "type": dtype
                });

                if let Ok(bytes) = serde_json::to_vec(&beacon) {
                    let mcast_target = SocketAddrV4::new(MULTICAST_ADDR, TURBO_PORT);
                    let bcast_target = SocketAddrV4::new(Ipv4Addr::new(255, 255, 255, 255), TURBO_PORT);
                    let _ = tx_sock.send_to(&bytes, mcast_target);
                    let _ = tx_sock.send_to(&bytes, bcast_target);
                }
                std::thread::sleep(Duration::from_millis(2000));
            }
        }
    });

    std::thread::spawn(move || {
        let socket = match Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)) {
            Ok(s) => s,
            Err(_) => return,
        };
        let _ = socket.set_reuse_address(true);
        let addr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, TURBO_PORT);
        if socket.bind(&addr.into()).is_err() {
            return;
        }
        let _ = socket.join_multicast_v4(&MULTICAST_ADDR, &Ipv4Addr::UNSPECIFIED);

        let rx_sock: UdpSocket = socket.into();
        let mut buf = [0u8; 2048];

        loop {
            if let Ok((len, src_addr)) = rx_sock.recv_from(&mut buf) {
                if let Ok(mut peer) = serde_json::from_slice::<LanPeer>(&buf[..len]) {
                    let my_id = state.node_id.lock().unwrap().clone();
                    if peer.id != my_id {
                        if peer.ip == "127.0.0.1" || peer.ip.is_empty() {
                            peer.ip = src_addr.ip().to_string();
                        }
                        peer.last_seen = now_sec();
                        state.peers.lock().unwrap().insert(peer.id.clone(), peer);
                    }
                }
            }
        }
    });
}

async fn run_turbo_http_server(state: Arc<AppState>) {
    let bind_addr = SocketAddr::from(([0, 0, 0, 0], TURBO_PORT));
    let listener = match TcpListener::bind(bind_addr).await {
        Ok(l) => l,
        Err(_) => return,
    };

    loop {
        if let Ok((stream, _)) = listener.accept().await {
            let _ = stream.set_nodelay(true);
            let st = state.clone();
            tokio::spawn(async move {
                let _ = handle_http_connection(stream, st).await;
            });
        }
    }
}

fn parse_content_length(header_str: &str) -> u64 {
    for line in header_str.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                if let Ok(len) = v.trim().parse::<u64>() {
                    return len;
                }
            }
        }
    }
    0
}

async fn handle_http_connection(mut stream: TcpStream, state: Arc<AppState>) -> std::io::Result<()> {
    let mut header_buf = vec![0u8; 16384];
    let mut read_total = 0usize;
    let header_end_pos;

    loop {
        let n = stream.read(&mut header_buf[read_total..]).await?;
        if n == 0 {
            return Ok(());
        }
        read_total += n;
        if let Some(pos) = header_buf[..read_total]
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
        {
            header_end_pos = pos + 4;
            break;
        }
        if read_total >= header_buf.len() {
            return Ok(());
        }
    }

    let header_str = String::from_utf8_lossy(&header_buf[..header_end_pos]);
    let first_line = header_str.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(());
    }

    let method = parts[0];
    let full_path = parts[1];
    let (path, query_str) = full_path.split_once('?').unwrap_or((full_path, ""));
    let params = parse_query_params(query_str);

    if method == "OPTIONS" {
        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\n\r\n";
        stream.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    if path == "/api/ping" {
        return send_json_response(&mut stream, "{\"ok\":true}").await;
    }

    if path == "/api/node-info" {
        let json = serde_json::json!({
            "nodeId": *state.node_id.lock().unwrap(),
            "deviceName": *state.device_name.lock().unwrap(),
            "lanIp": state.lan_ip,
            "port": TURBO_PORT
        });
        return send_json_response(&mut stream, &json.to_string()).await;
    }

    if path == "/api/lan-peers" {
        if let Some(id) = params.get("id") {
            *state.node_id.lock().unwrap() = id.clone();
        }
        if let Some(name) = params.get("name") {
            *state.device_name.lock().unwrap() = name.clone();
        }
        if let Some(os) = params.get("os") {
            *state.os_name.lock().unwrap() = os.clone();
        }
        if let Some(dtype) = params.get("type") {
            *state.device_type.lock().unwrap() = dtype.clone();
        }

        let now = now_sec();
        let mut peers_lock = state.peers.lock().unwrap();
        peers_lock.retain(|_, p| now.saturating_sub(p.last_seen) <= 10);
        let active_peers: Vec<LanPeer> = peers_lock.values().cloned().collect();
        drop(peers_lock);

        let mut notices_lock = state.incoming_notices.lock().unwrap();
        let notices: Vec<IncomingFileNotice> = notices_lock.drain(..).collect();
        drop(notices_lock);

        let json = serde_json::json!({
            "peers": active_peers,
            "incomingFiles": notices
        });
        return send_json_response(&mut stream, &json.to_string()).await;
    }

    if path == "/api/cli-staged" {
        let list = state.cli_files.lock().unwrap().clone();
        let json = serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string());
        return send_json_response(&mut stream, &json).await;
    }

    if path == "/api/cli-file" {
        if let Some(target_id) = params.get("id") {
            let maybe_path = {
                let mut lock = state.cli_files.lock().unwrap();
                if let Some(idx) = lock.iter().position(|x| &x.id == target_id) {
                    Some(lock.remove(idx).path)
                } else {
                    None
                }
            };
            if let Some(file_path) = maybe_path {
                return serve_disk_file(&mut stream, &file_path, "application/octet-stream").await;
            }
        }
        return send_404(&mut stream).await;
    }

    // Route: Save WebRTC / Global Link Blob directly to Native Downloads (/api/save-local) or Turbo Upload (/api/upload)
    if method == "POST" && (path == "/api/upload" || path == "/api/save-local") {
        let raw_name = params.get("name").cloned().unwrap_or_else(|| "received_file.bin".to_string());
        let expected_size = params
            .get("size")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or_else(|| parse_content_length(&header_str));
        let sender = params.get("sender").cloned().unwrap_or_else(|| "Peer".to_string());

        let (dest_path, final_name) = get_unique_file_path(&state.downloads_dir, &raw_name);
        let mut out_file = File::create(&dest_path).await?;

        let already_read_body = &header_buf[header_end_pos..read_total];
        let mut written: u64 = 0;
        if !already_read_body.is_empty() {
            out_file.write_all(already_read_body).await?;
            written += already_read_body.len() as u64;
        }

        let mut chunk_buf = vec![0u8; 1048576];
        while written < expected_size {
            let to_read = std::cmp::min(chunk_buf.len() as u64, expected_size - written) as usize;
            let n = stream.read(&mut chunk_buf[..to_read]).await?;
            if n == 0 {
                break;
            }
            out_file.write_all(&chunk_buf[..n]).await?;
            written += n as u64;
        }
        out_file.flush().await?;

        if path == "/api/upload" {
            state.incoming_notices.lock().unwrap().push(IncomingFileNotice {
                file_name: final_name.clone(),
                file_size: written,
                sender,
            });
        }

        let resp_json = serde_json::json!({
            "saved": true,
            "savedName": final_name
        });
        return send_json_response(&mut stream, &resp_json.to_string()).await;
    }

    // Serve Embedded Web UI Assets for Zero-Install Wi-Fi / Hotspot Guests
    let rel_path = if path == "/" || path.is_empty() {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };

    if let Some((bytes, mime)) = get_embedded_web_asset(rel_path) {
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\r\n",
            mime,
            bytes.len()
        );
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(bytes).await?;
        return Ok(());
    }

    send_404(&mut stream).await
}

async fn send_json_response(stream: &mut TcpStream, body: &str) -> std::io::Result<()> {
    let bytes = body.as_bytes();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n",
        bytes.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(bytes).await?;
    Ok(())
}

async fn serve_disk_file(stream: &mut TcpStream, path: &Path, mime: &str) -> std::io::Result<()> {
    let mut file = match File::open(path).await {
        Ok(f) => f,
        Err(_) => return send_404(stream).await,
    };
    let meta = file.metadata().await?;
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\r\n",
        mime,
        meta.len()
    );
    stream.write_all(header.as_bytes()).await?;
    tokio::io::copy(&mut file, stream).await?;
    Ok(())
}

async fn send_404(stream: &mut TcpStream) -> std::io::Result<()> {
    let resp = "HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 9\r\n\r\nNot Found";
    stream.write_all(resp.as_bytes()).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut cli_items = Vec::new();
    for (idx, arg) in env::args().skip(1).enumerate() {
        let p = PathBuf::from(&arg);
        if p.is_file() {
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();
            cli_items.push(CliStagedItem {
                id: format!("CLI-{}", idx),
                name,
                path: p,
            });
        }
    }

    let state = Arc::new(AppState {
        node_id: Mutex::new("NODE-NATIVE".to_string()),
        device_name: Mutex::new("convoyOS Turbo Node".to_string()),
        os_name: Mutex::new(env::consts::OS.to_uppercase()),
        device_type: Mutex::new("desktop".to_string()),
        lan_ip: detect_lan_ipv4(),
        downloads_dir: resolve_downloads_dir(),
        peers: Mutex::new(HashMap::new()),
        incoming_notices: Mutex::new(Vec::new()),
        cli_files: Mutex::new(cli_items),
    });

    spawn_udp_multicast_radar(state.clone());

    let http_state = state.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(run_turbo_http_server(http_state));
    });

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running convoyOS native application");
}