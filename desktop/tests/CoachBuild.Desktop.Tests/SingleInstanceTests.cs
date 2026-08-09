using CoachBuild.Desktop;
using Xunit;

namespace CoachBuild.Desktop.Tests;

public sealed class SingleInstanceTests
{
    [Fact]
    public void NativeMutexNameRemainsCompatibleWithLegacyCompanion()
    {
        Assert.Equal("Local\\CoachBuildCompanion", App.CompanionMutexName);
    }

    [Fact]
    public void SessionTokenIsPersistentAndNeverShortOrPlaintext()
    {
        var root = Path.Combine(Path.GetTempPath(), "CoachBuild-TokenTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var path = Path.Combine(root, "session-token");
            var first = SessionTokenStore.ReadOrCreate(path);
            var second = SessionTokenStore.ReadOrCreate(path);

            Assert.True(SessionTokenStore.IsValid(first));
            Assert.Equal(first, second);
            Assert.Equal(64, first.Length);
            Assert.DoesNotContain("session", first, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void InvalidPersistedTokenIsReplaced()
    {
        var root = Path.Combine(Path.GetTempPath(), "CoachBuild-TokenTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var path = Path.Combine(root, "session-token");
            File.WriteAllText(path, "bad");
            var token = SessionTokenStore.ReadOrCreate(path);

            Assert.True(SessionTokenStore.IsValid(token));
            Assert.NotEqual("bad", token);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}

