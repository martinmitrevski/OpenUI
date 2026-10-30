import SwiftUI

struct SettingsView: View {
    @Bindable var store: ChatStore
    @Environment(\.dismiss) private var dismiss
    @State private var isChecking = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(ChatStore.defaultBackendURL, text: $store.backendURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        Task {
                            isChecking = true
                            await store.checkHealth()
                            isChecking = false
                        }
                    } label: {
                        HStack {
                            Text("Check connection")
                            if isChecking {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                } header: {
                    Text("Backend")
                } footer: {
                    BackendStatusView(store: store)
                }

                Section("Running the backend") {
                    Text("cd SampleBackend\nnpm start")
                        .font(.footnote.monospaced())
                    Text("Without an API key the backend answers with scripted demo responses. Run `npm install` and set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to get live answers.")
                    Text("On a physical device, start the backend with `HOST=0.0.0.0` and use your Mac's address, such as `http://my-mac.local:8787`.")
                }
                .font(.footnote)
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
