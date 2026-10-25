"""E2E: host (desktop) + tamu (HP landscape) lewat WebRTC sungguhan.
Jalankan: python3 test/e2e.py   (pip install playwright && playwright install chromium)"""
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 3917
srv = subprocess.Popen(['node', '-e', "require('./dev-server.js').start(%d).then(()=>console.log('up'))" % PORT], cwd=ROOT, stdout=subprocess.PIPE)
srv.stdout.readline()
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
        "--disable-features=WebRtcHideLocalIpsWithMdns", "--allow-loopback-in-peer-connection"]
ok = True


def check(name, cond, extra=''):
    global ok
    print(('  ✔ ' if cond else '  ✘ ') + name + (' ' + str(extra) if extra != '' else ''))
    if not cond:
        ok = False


try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=ARGS)
        hc = b.new_context(viewport={'width': 640, 'height': 400})
        gc = b.new_context(viewport={'width': 800, 'height': 360}, has_touch=True, is_mobile=True, device_scale_factor=1)
        INIT = "localStorage.setItem('numberbomber.settings.v1', JSON.stringify({quality:'low',effects:false,volume:0}))"   # render software: hemat
        hc.add_init_script(INIT); gc.add_init_script(INIT)
        h = hc.new_page(); g = gc.new_page()
        for pg, n in ((h, 'H'), (g, 'G')):
            pg.on('pageerror', lambda e, n=n: print('  PAGEERROR', n, e))
            pg.on('console', lambda m, n=n: print('  console', n, m.text) if m.type == 'error' else None)
        h.goto('http://localhost:%d/' % PORT); h.wait_for_function('window.__nb && window.__nb.ready')
        h.click('#btn-online'); h.fill('#ol-name', 'Andi'); h.click('#ol-create')
        h.wait_for_selector('#ol-room:not(.hidden)')
        code = h.inner_text('#ol-room-code'); check('kode ruangan 5 karakter', len(code) == 5, code)
        g.goto('http://localhost:%d/?room=%s' % (PORT, code)); g.wait_for_function('window.__nb && window.__nb.ready')
        g.fill('#ol-name', 'Budi'); g.click('#ol-join')
        h.wait_for_function("!document.getElementById('ol-go').disabled", timeout=40000)
        check('host: tombol MULAI aktif', True)
        mode = h.evaluate('window.__nb.online.net.mode'); check('koneksi langsung (bukan relay)', mode == 'p2p', mode)
        h.click('#ol-go')
        g.wait_for_function("window.__nb.GS.current==='playing'", timeout=40000)
        h.wait_for_function("window.__nb.GS.current==='playing'", timeout=40000)
        check('kedua sisi masuk PLAYING', True)
        check('layout peti identik', h.evaluate('window.__nb.arena.serialize()') == g.evaluate('window.__nb.arena.serialize()'))
        cls = g.evaluate('document.documentElement.className')
        check('tamu: mode online + touch aktif', 'online' in cls and 'touch' in cls and 'me1' in cls, cls)
        x0 = g.evaluate('window.__nb.players[0].x')
        h.keyboard.down('KeyD'); time.sleep(0.8); h.keyboard.up('KeyD'); time.sleep(0.3)
        hx = h.evaluate('window.__nb.players[0].x'); gx = g.evaluate('window.__nb.players[0].x')
        check('gerak host tampil di tamu', gx > x0 + 0.2 and abs(hx - gx) < 0.3, (round(x0, 2), round(hx, 2), round(gx, 2)))
        g.screenshot(path='/tmp/guest_play.png')
        gz0 = h.evaluate('window.__nb.players[1].z')
        g.evaluate("""()=>{const z=document.getElementById('ot-zone');
          const mk=(t,x,y)=>z.dispatchEvent(new PointerEvent(t,{pointerId:7,clientX:x,clientY:y,bubbles:true,pointerType:'touch'}));
          window.__mk=mk; mk('pointerdown',150,250); mk('pointermove',150,200);}""")
        time.sleep(0.9)
        g.evaluate("window.__mk('pointerup',150,200)"); time.sleep(0.3)
        gz = g.evaluate('window.__nb.players[1].z'); hz = h.evaluate('window.__nb.players[1].z')
        check('joystick tamu menggerakkan pemain', gz < gz0 - 0.5, (round(gz0, 2), round(gz, 2)))
        check('posisi tamu sampai ke host', abs(hz - gz) < 0.35, (round(gz, 2), round(hz, 2)))
        g.evaluate("window.__nb.input.pushAction(1,'bomb')")
        g.wait_for_function('window.__nb.bombs.bombs.size===1', timeout=5000)
        check('bom tamu muncul di tamu pada frame berikutnya (prediksi lokal)', True)
        h.wait_for_function('[...window.__nb.bombs.bombs.values()].some(b=>b.owner===1)', timeout=5000)
        check('host menerima bom tamu', h.evaluate('[...window.__nb.bombs.bombs.values()].filter(b=>b.owner===1).length') == 1)
        check('bom tamu terkonfirmasi', g.evaluate('[...window.__nb.bombs.bombs.values()].every(b=>!b.ghost)'))
        h.keyboard.press('Space'); g.wait_for_function('[...window.__nb.bombs.bombs.values()].some(b=>b.owner===0)', timeout=8000)
        check('bom host tampil di tamu', g.evaluate('[...window.__nb.bombs.bombs.values()].filter(b=>b.owner===0).length') == 1)
        g.wait_for_function('window.__nb.bombs.bombs.size===0', timeout=30000); h.wait_for_function('window.__nb.bombs.bombs.size===0', timeout=30000)
        check('ledakan: bom hilang di kedua sisi', h.evaluate('window.__nb.bombs.bombs.size') == 0 and g.evaluate('window.__nb.bombs.bombs.size') == 0)
        lv = (h.evaluate('window.__nb.players.map(p=>p.lives)'), g.evaluate('window.__nb.players.map(p=>p.lives)'))
        check('nyawa sinkron host=tamu', lv[0] == lv[1], lv)
        g.evaluate("window.__nb.input.pushAction(1,'qopen')"); time.sleep(0.2)
        check('soal tamu terbuka seketika (lokal)', g.evaluate('!!window.__nb.math.state[1].q'))
        g.screenshot(path='/tmp/guest_math.png'); h.screenshot(path='/tmp/host_play.png')
        rtt = g.evaluate('window.__nb.online.net.rtt'); check('ping terukur', 0 < rtt < 200, round(rtt, 1))
        # akhiri ronde: P2 kehabisan nyawa di host
        h.evaluate("()=>{const a=window.__nb;const p=a.players[1];p.lives=1;if(p.takeDamage(999))a.bombs.onDamage(p,'hit');}")
        g.wait_for_function("['round_over','match_over'].includes(window.__nb.GS.current)", timeout=8000)
        check('ronde berakhir juga di tamu', True)
        g.wait_for_function('window.__nb.resultShown', timeout=20000); g.screenshot(path='/tmp/guest_result.png')
        sc = g.evaluate('window.__nb.match.scores.join("-")'); check('tamu melihat skor 1-0', sc == '1-0', sc)
        g.evaluate("document.getElementById('btn-next').click()")
        g.wait_for_function("window.__nb.GS.current==='countdown'", timeout=8000)
        check('tamu minta ronde berikutnya → ronde 2 mulai', g.evaluate('window.__nb.match.round') == 2)
        g.evaluate("window.__nb.online.leave()"); time.sleep(1.2)
        h.wait_for_function("window.__nb.GS.current==='match_over'", timeout=10000)
        sub = h.inner_text('#result-sub'); check('host diberi tahu lawan keluar', 'keluar' in sub.lower() or 'putus' in sub.lower(), sub)
        b.close()
finally:
    srv.terminate()
print('SEMUA LULUS' if ok else 'ADA YANG GAGAL'); sys.exit(0 if ok else 1)
