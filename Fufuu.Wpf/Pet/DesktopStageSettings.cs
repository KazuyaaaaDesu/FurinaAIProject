using System.Text.Json;
using System.Windows;
using System.Windows.Forms;
using System.IO;

namespace Fufuu.Wpf.Pet;

public sealed record DesktopStageSettings
{
    public string DisplayMode { get; init; } = "png";
    public int? RendererModeVersion { get; init; }
    public double Width { get; init; } = 520;
    public double Height { get; init; } = 680;
    public double CharacterScale { get; init; } = 1.0;
    public double CharacterX { get; init; }
    public double CharacterY { get; init; }
    public double WalkingSpeed { get; init; } = 0.16;
    public bool RoamingEnabled { get; init; }
    public bool AlwaysOnTop { get; init; } = true;
    public bool EdgeHideEnabled { get; init; }
    public bool ClickThroughEnabled { get; init; }
    public bool MouseAvoidanceEnabled { get; init; }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public static DesktopStageSettings Defaults { get; } = new();

    public static DesktopStageSettings Load(string path)
    {
        try
        {
            if (!File.Exists(path)) return Defaults;
            var value = JsonSerializer.Deserialize<DesktopStageSettings>(File.ReadAllText(path), JsonOptions);
            if (value is null || !value.IsValid()) return Defaults;
            if (value.RendererModeVersion is null)
            {
                value = value with { DisplayMode = "png", RendererModeVersion = 1 };
                value.Save(path);
            }
            return value;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return Defaults;
        }
    }

    public bool IsValid() =>
        (DisplayMode is "png" or "2d" or "3d") && double.IsFinite(Width) && Width is >= 240 and <= 10000 &&
        double.IsFinite(Height) && Height is >= 320 and <= 10000 &&
        double.IsFinite(CharacterScale) && CharacterScale is >= 0.5 and <= 1.35 &&
        double.IsFinite(CharacterX) && CharacterX is >= -1 and <= 1 &&
        double.IsFinite(CharacterY) && CharacterY is >= -1 and <= 1 &&
        double.IsFinite(WalkingSpeed) && WalkingSpeed is >= 0.05 and <= 0.5;

    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(this with { RendererModeVersion = 1 }, new JsonSerializerOptions(JsonOptions) { WriteIndented = true }));
    }

    public static IReadOnlyList<DisplayInfo> GetDisplays() =>
        Screen.AllScreens.Select((screen, index) => new DisplayInfo(index, screen.DeviceName, ToRect(screen.Bounds), ToRect(screen.WorkingArea), screen.Primary)).ToArray();

    private static Rect ToRect(System.Drawing.Rectangle r) => new(r.X, r.Y, r.Width, r.Height);
}

public sealed record DisplayInfo(int Id, string DeviceName, Rect Bounds, Rect WorkArea, bool IsPrimary);
