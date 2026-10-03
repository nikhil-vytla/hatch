// PROTOTYPE — Who said that? for the Mac menu bar.
//
// Records 5 s of you, 5 s of your friend, then your conversation, all to local 16 kHz WAVs, and
// hands them to the same pipeline the website runs (live-worlds/who-said-that/cli.proto.ts via
// Bun): whisper-tiny.en, all-MiniLM-L6-v2 and CAM++, on this Mac. The transcript lands in
// ~/Documents/Who said that/ as Markdown and opens. Nothing is uploaded.
import AppKit
import AVFoundation

final class App: NSObject, NSApplicationDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let status = NSMenuItem(title: "Ready: record yourself first", action: nil, keyEquivalent: "")
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
    menu.addItem(withTitle: "Record me (5 s)", action: #selector(recordMe), keyEquivalent: "1").target = self
    menu.addItem(withTitle: "Record my friend (5 s)", action: #selector(recordFriend), keyEquivalent: "2").target = self
    menu.addItem(withTitle: "Start the conversation", action: #selector(startTalk), keyEquivalent: "s").target = self
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

  private func record(_ name: String, seconds: Double?) {
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
    guard let seconds else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
      self?.recorder?.stop()
      self?.say(name == "me" ? "Got you. Now record your friend" : "Got your friend. Start the conversation")
    }
  }

  @objc private func recordMe() { say("Recording you… speak for 5 s"); record("me", seconds: 5) }
  @objc private func recordFriend() { say("Recording your friend… 5 s"); record("friend", seconds: 5) }
  @objc private func startTalk() { say("Listening to the conversation…"); record("talk", seconds: nil) }

  @objc private func stopTalk() {
    recorder?.stop()
    recorder = nil
    let fm = FileManager.default
    guard ["me", "friend", "talk"].allSatisfy({ fm.fileExists(atPath: file($0).path) }) else {
      say("Record yourself, your friend and the conversation first")
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
    p.arguments = ["live-worlds/who-said-that/cli.proto.ts", "--me", file("me").path, "--friend", file("friend").path,
                   "--talk", file("talk").path, "--out", out.path]
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
