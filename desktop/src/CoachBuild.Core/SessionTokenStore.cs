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

    public string GetOrCreate()
    {
        try
        {
            Directory.CreateDirectory(BaseDirectory);
            if (File.Exists(FilePath))
            {
                var existing = File.ReadAllText(FilePath).Trim();
                if (!string.IsNullOrEmpty(existing)) return existing;
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
            return !string.IsNullOrEmpty(token);
        }
        catch
        {
            token = null;
            return false;
        }
    }
}

