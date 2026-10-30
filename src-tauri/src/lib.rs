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
    web_root: PathBuf,
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
        if let Ok(home) = env::var("HOME") {
            let p = PathBuf::from(home).join("Downloads");
            if p.exists() {
                return p;
            }
        }
        let android_dl = PathBuf::from("/storage/emulated/0/Download");
        if android_dl.exists() {
            return android_dl;
        }
    }
    env::temp_dir()
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

// =========================================================================
// 1. 0% INTERNET UDP MULTICAST & HOTSPOT BROADCAST ENGINE
// =========================================================================
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

// =========================================================================
// 2. KERNEL TCP/HTTP TURBO SERVER + ZERO-INSTALL HOTSPOT WEB HOST
// =========================================================================
async fn run_turbo_http_server(state: Arc<AppState>) {
    let bind_addr = SocketAddr::from(([0, 0, 0, 0], TURBO_PORT));
    let listener = match TcpListener::bind(bind_addr).await {
        Ok(l) => l,
        Err(_) => return,
    };

    loop {
        if let Ok((stream, _)) = listener.accept().await {
            let _ = stream.set_nodelay(true); // Disable Nagle's algorithm for instant chunk flush
            let st = state.clone();
            tokio::spawn(async move {
                let _ = handle_http_connection(stream, st).await;
            });
        }
    }
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

    // Handle CORS Preflight
    if method == "OPTIONS" {
        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\n\r\n";
        stream.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    // Route 1: Health Ping
    if path == "/api/ping" {
        return send_json_response(&mut stream, "{\"ok\":true}").await;
    }

    // Route 2: Node Info
    if path == "/api/node-info" {
        let json = serde_json::json!({
            "nodeId": *state.node_id.lock().unwrap(),
            "deviceName": *state.device_name.lock().unwrap(),
            "lanIp": state.lan_ip,
            "port": TURBO_PORT
        });
        return send_json_response(&mut stream, &json.to_string()).await;
    }

    // Route 3: Poll Discovered UDP Multicast Peers & Completed Incoming Uploads
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

    // Route 4: Windows Explorer Right-Click ("Send with convoyOS") Staged CLI Files
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

    // Route 5: Zero-Copy Kernel Turbo Upload (POST /api/upload)
    if method == "POST" && path == "/api/upload" {
        let raw_name = params.get("name").cloned().unwrap_or_else(|| "received_file.bin".to_string());
        let safe_name = Path::new(&raw_name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("received_file.bin")
            .to_string();
        let expected_size = params
            .get("size")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let sender = params.get("sender").cloned().unwrap_or_else(|| "Peer".to_string());

        let dest_path = state.downloads_dir.join(&safe_name);
        let mut out_file = File::create(&dest_path).await?;

        let already_read_body = &header_buf[header_end_pos..read_total];
        let mut written: u64 = 0;
        if !already_read_body.is_empty() {
            out_file.write_all(already_read_body).await?;
            written += already_read_body.len() as u64;
        }

        // Stream directly from TCP socket to disk in 1 MB kernel blocks (Zero RAM bloat)
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

        state.incoming_notices.lock().unwrap().push(IncomingFileNotice {
            file_name: safe_name,
            file_size: written,
            sender,
        });

        return send_json_response(&mut stream, "{\"saved\":true}").await;
    }

    // Route 6: Zero-Install Wi-Fi / Hotspot Web Host (Serves index.html, css/, js/, assets/)
    let rel_path = if path == "/" || path.is_empty() {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };

    if rel_path.contains("..") {
        return send_404(&mut stream).await;
    }

    let disk_path = state.web_root.join(rel_path);
    if disk_path.is_file() {
        let mime = guess_mime_type(&disk_path);
        return serve_disk_file(&mut stream, &disk_path, mime).await;
    }

    send_404(&mut stream).await
}

fn guess_mime_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
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
    // Capture any files passed via Windows Explorer Right-Click ("Send with convoyOS")
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

    let current_dir = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let web_root = if current_dir.join("index.html").exists() {
        current_dir
    } else {
        current_dir.parent().unwrap_or(Path::new(".")).to_path_buf()
    };

    let state = Arc::new(AppState {
        node_id: Mutex::new("NODE-NATIVE".to_string()),
        device_name: Mutex::new("convoyOS Turbo Node".to_string()),
        os_name: Mutex::new(env::consts::OS.to_uppercase()),
        device_type: Mutex::new("desktop".to_string()),
        lan_ip: detect_lan_ipv4(),
        web_root,
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