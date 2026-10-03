// PROTOTYPE TOOL — Who said that? for the Mac menu bar.
//
// Records the room to a local 16 kHz WAV and hands it to the same decisions the website runs
// (live-worlds/who-said-that/cli.ts via Bun): whisper-tiny.en, all-MiniLM-L6-v2 and CAM++ for the
// signals, then the free typed decisions for speaker, conversation and topic, on this Mac. The
// transcript, sorted into conversations and speakers, lands in ~/Documents/Who said that/ as
// Markdown and opens. Nothing is uploaded.
import AppKit
import AVFoundation

final class App: NSObject, NSApplicationDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let status = NSMenuItem(title: "Ready to listen", action: nil, keyEquivalent: "")
  private var started: Date?
  private var ticker: Timer?
  private var recorder: AVAudioRecorder?
  private var lastTranscript: URL?
  private let work: URL = {
    let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("WhoSaidThat")
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
  }()

  private func file(_ name: String) -> URL { work.appendingPathComponent("\(name).wav") }

  func applicationDidFinishLaunching(_ note: Notification) {
    item.button?.image = NSImage(systemSymbolName: "person.2.wave.2", accessibilityDescription: "Who said that?")
    let menu = NSMenu()
    status.isEnabled = false
    menu.addItem(status)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Start listening", action: #selector(startTalk), keyEquivalent: "s").target = self
    menu.addItem(withTitle: "Stop and write the transcript", action: #selector(stopTalk), keyEquivalent: "t").target = self
    menu.addItem(.separator())
    menu.addItem(withTitle: "Open the last transcript", action: #selector(openLast), keyEquivalent: "o").target = self
    menu.addItem(withTitle: "Show recordings folder", action: #selector(showFolder), keyEquivalent: "").target = self
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    item.menu = menu
    // --show-menu opens the menu for a screenshot and skips the microphone prompt.
    if CommandLine.arguments.contains("--show-menu") {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.item.button?.performClick(nil) }
      return
    }
    AVCaptureDevice.requestAccess(for: .audio) { ok in
      DispatchQueue.main.async { if !ok { self.say("Microphone access is off: System Settings → Privacy → Microphone") } }
    }
  }

  private func say(_ s: String) { status.title = s }

  private func record(_ name: String) {
    recorder?.stop()
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
    ]
    do {
      recorder = try AVAudioRecorder(url: file(name), settings: settings)
      recorder?.record()
    } catch {
      say("Could not record: \(error.localizedDescription)")
      return
    }
  }

  @objc private func startTalk() {
    record("room")
    started = Date()
    say("Listening… 0:00")
    ticker?.invalidate()
    ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let self, let started = self.started else { return }
      let s = Int(Date().timeIntervalSince(started))
      self.say(String(format: "Listening… %d:%02d", s / 60, s % 60))
    }
  }

  @objc private func stopTalk() {
    recorder?.stop()
    recorder = nil
    ticker?.invalidate()
    started = nil
    let fm = FileManager.default
    guard fm.fileExists(atPath: file("room").path) else {
      say("Start listening first")
      return
    }
    let info = Bundle.main.infoDictionary ?? [:]
    guard let repo = info["WSTRepo"] as? String, let bun = info["WSTBun"] as? String else {
      say("Rebuild with build.sh so the app knows where the pipeline is")
      return
    }
    let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Who said that")
    try? fm.createDirectory(at: docs, withIntermediateDirectories: true)
    let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
    let out = docs.appendingPathComponent("Transcript \(stamp).md")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: bun)
    p.currentDirectoryURL = URL(fileURLWithPath: repo).appendingPathComponent("jev-experiments")
    p.arguments = ["live-worlds/who-said-that/cli.ts", file("room").path, "--out", out.path]
    say("Writing the transcript (on this Mac)…")
    p.terminationHandler = { proc in
      DispatchQueue.main.async {
        if proc.terminationStatus == 0 {
          self.lastTranscript = out
          self.say("Done: transcript saved")
          NSWorkspace.shared.open(out)
        } else {
          self.say("The pipeline failed (exit \(proc.terminationStatus))")
        }
      }
    }
    do { try p.run() } catch { say("Could not start Bun: \(error.localizedDescription)") }
  }

  @objc private func openLast() { if let u = lastTranscript { NSWorkspace.shared.open(u) } }
  @objc private func showFolder() { NSWorkspace.shared.open(work) }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
