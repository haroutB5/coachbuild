namespace CoachBuild.Core;

public sealed class SessionTokenStore
{
    public string BaseDirectory { get; }
    public string FilePath => Path.Combine(BaseDirectory, CompanionWire.SessionFileName);

    public SessionTokenStore(string? baseDirectory = null)
    {
        BaseDirectory = baseDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "CoachBuild");
    }

    /// <summary>
    /// The token file is shared with the PowerShell bridge and the Desktop
    /// app's own store, which mint different shapes (32-hex Guid "N" here,
    /// 64-hex there), so the rule accepts any all-hex token of 32+ chars —
    /// the same rule as the Desktop store's IsValid. Anything else (a
    /// truncated write, a tampered file) is treated as absent: GetOrCreate
    /// mints fresh, TryRead reports false, and the browser re-pairs instead
    /// of running a session no bridge will ever accept.
    /// </summary>
    public static bool IsValidSessionToken(string? token) =>
        !string.IsNullOrWhiteSpace(token)
        && token.Length >= 32
        && token.All(static c => c is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F');

    public string GetOrCreate()
    {
        try
        {
            Directory.CreateDirectory(BaseDirectory);
            if (File.Exists(FilePath))
            {
                var existing = File.ReadAllText(FilePath).Trim();
                if (IsValidSessionToken(existing)) return existing;
            }

            var token = Guid.NewGuid().ToString("N");
            File.WriteAllText(FilePath, token, new System.Text.UTF8Encoding(false));
            return token;
        }
        catch
        {
            // A read-only profile or an antivirus lock must never prevent the
            // bridge from starting. The browser will simply need to re-pair.
            return Guid.NewGuid().ToString("N");
        }
    }

    public bool TryRead(out string? token)
    {
        try
        {
            token = File.Exists(FilePath) ? File.ReadAllText(FilePath).Trim() : null;
            if (!IsValidSessionToken(token))
            {
                token = null;
                return false;
            }
            return true;
        }
        catch
        {
            token = null;
            return false;
        }
    }
}

