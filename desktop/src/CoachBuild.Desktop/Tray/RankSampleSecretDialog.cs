using System.Drawing;
using Forms = System.Windows.Forms;

namespace CoachBuild.Desktop.Tray;

/// <summary>
/// One-way copy/paste handoff for the My Stats shared secret.
///
/// <para>The constructor receives only whether a credential exists, never the
/// credential itself. Consequently the saved value cannot be prefilled,
/// revealed, copied back out, or accidentally included in control diagnostics.
/// The input is masked for the whole lifetime of the dialog.</para>
/// </summary>
internal sealed class RankSampleSecretDialog : Forms.Form
{
    private readonly Forms.TextBox _secretInput;
    private readonly Forms.Button _saveButton;

    internal RankSampleSecretDialog(bool replacingExisting)
    {
        Text = "Pair desktop with My Stats";
        ClientSize = new Size(480, 232);
        FormBorderStyle = Forms.FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowIcon = false;
        ShowInTaskbar = false;
        StartPosition = Forms.FormStartPosition.CenterScreen;
        TopMost = true;
        AutoScaleMode = Forms.AutoScaleMode.Dpi;
        Font = SystemFonts.MessageBoxFont;

        var instructions = new Forms.Label
        {
            AutoSize = false,
            Left = 20,
            Top = 18,
            Width = 440,
            Height = 52,
            Text = replacingExisting
                ? "A pairing secret is already saved. Paste the secret from My Stats below to replace it."
                : "On the My Stats page, choose Pair desktop and copy the shared secret. Paste it below once.",
        };

        var fieldLabel = new Forms.Label
        {
            AutoSize = true,
            Left = 20,
            Top = 79,
            Text = "Shared secret",
        };

        _secretInput = new Forms.TextBox
        {
            AccessibleName = "My Stats shared secret",
            Left = 20,
            Top = 101,
            Width = 440,
            UseSystemPasswordChar = true,
            ShortcutsEnabled = true,
            TabIndex = 0,
        };

        var privacy = new Forms.Label
        {
            AutoSize = false,
            Left = 20,
            Top = 135,
            Width = 440,
            Height = 34,
            Text = "Stored in CoachBuild's existing desktop settings. Never written to companion.log or shown here again.",
        };

        _saveButton = new Forms.Button
        {
            Text = "Save pairing",
            Left = 344,
            Top = 187,
            Width = 116,
            Height = 28,
            Enabled = false,
            DialogResult = Forms.DialogResult.OK,
            TabIndex = 1,
        };
        var cancelButton = new Forms.Button
        {
            Text = "Cancel",
            Left = 250,
            Top = 187,
            Width = 84,
            Height = 28,
            DialogResult = Forms.DialogResult.Cancel,
            TabIndex = 2,
        };

        _secretInput.TextChanged += (_, _) =>
            _saveButton.Enabled = !string.IsNullOrWhiteSpace(_secretInput.Text);

        Controls.Add(instructions);
        Controls.Add(fieldLabel);
        Controls.Add(_secretInput);
        Controls.Add(privacy);
        Controls.Add(cancelButton);
        Controls.Add(_saveButton);
        AcceptButton = _saveButton;
        CancelButton = cancelButton;
        Shown += (_, _) => _secretInput.Focus();
    }

    internal Forms.TextBox SecretInputForTesting => _secretInput;

    internal Forms.Button SaveButtonForTesting => _saveButton;

    internal static string? Prompt(bool replacingExisting)
    {
        using var dialog = new RankSampleSecretDialog(replacingExisting);
        return dialog.ShowDialog() == Forms.DialogResult.OK
            ? dialog._secretInput.Text.Trim()
            : null;
    }
}
