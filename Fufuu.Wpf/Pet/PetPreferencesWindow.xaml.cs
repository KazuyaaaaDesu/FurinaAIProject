using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;

namespace Fufuu.Wpf.Pet;

/// <summary>
/// Preferences for the desktop pet: renderer mode, scale, position,
/// roaming behavior, and window behavior. Changes are persisted through
/// the owning <see cref="DesktopPetWindow"/> and pushed to the React pet stage.
/// </summary>
public partial class PetPreferencesWindow : Window
{
    private readonly DesktopPetWindow _petWindow;
    private readonly DesktopStageSettings _original;

    public PetPreferencesWindow(DesktopPetWindow petWindow)
    {
        _petWindow = petWindow;
        _original = petWindow.Settings;

        InitializeComponent();

        DisplayModeCombo.SelectedValue = _original.DisplayMode;
        CharacterScaleSlider.Value = _original.CharacterScale;
        CharacterXSlider.Value = _original.CharacterX;
        CharacterYSlider.Value = _original.CharacterY;
        WalkingSpeedSlider.Value = _original.WalkingSpeed;
        RoamingCheck.IsChecked = _original.RoamingEnabled;
        AlwaysOnTopCheck.IsChecked = _original.AlwaysOnTop;
        EdgeHideCheck.IsChecked = _original.EdgeHideEnabled;

        UpdateValueLabels();
    }

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }


    private void Save_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            LogSaveDiagnostic("Save button clicked.");

            var selectedMode = DisplayModeCombo.SelectedValue?.ToString();

            LogSaveDiagnostic(
                $"Selected mode={selectedMode ?? "<null>"}, " +
                $"Scale={CharacterScaleSlider.Value:0.00}, " +
                $"X={CharacterXSlider.Value:0.00}, " +
                $"Y={CharacterYSlider.Value:0.00}, " +
                $"Speed={WalkingSpeedSlider.Value:0.00}, " +
                $"Roaming={RoamingCheck.IsChecked}");

            if (string.IsNullOrWhiteSpace(selectedMode))
            {
                System.Windows.MessageBox.Show(
                    this,
                    "Please select a display mode.",
                    "Pet Preferences",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
                return;
            }

            var next = _original with
            {
                DisplayMode = selectedMode,
                CharacterScale = CharacterScaleSlider.Value,
                CharacterX = CharacterXSlider.Value,
                CharacterY = CharacterYSlider.Value,
                WalkingSpeed = WalkingSpeedSlider.Value,
                RoamingEnabled = RoamingCheck.IsChecked ?? false,
                AlwaysOnTop = AlwaysOnTopCheck.IsChecked ?? false,
                EdgeHideEnabled = EdgeHideCheck.IsChecked ?? false,
            };

            if (!next.IsValid())
            {
                LogSaveDiagnostic("Validation failed.");

                System.Windows.MessageBox.Show(
                    this,
                    "Please correct the preference values and try again.",
                    "Pet Preferences",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
                return;
            }

            LogSaveDiagnostic("Calling DesktopPetWindow.ApplySettings().");
            _petWindow.ApplySettings(next);
            LogSaveDiagnostic("ApplySettings() returned successfully.");

            Close();
        }
        catch (Exception ex)
        {
            LogSaveDiagnostic($"SAVE ERROR: {ex}");
            System.Windows.MessageBox.Show(
                this,
                $"Could not apply pet preferences:\n{ex.Message}",
                "Pet Preferences",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
    }

    private static void LogSaveDiagnostic(string message)
    {
        try
        {
            var directory = System.IO.Path.Combine(
                Environment.GetFolderPath(
                    Environment.SpecialFolder.LocalApplicationData),
                "Lumi");

            System.IO.Directory.CreateDirectory(directory);

            var path = System.IO.Path.Combine(
                directory, "desktop-pet-debug.log");

            System.IO.File.AppendAllText(
                path,
                $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] " +
                $"[Preferences] {message}{Environment.NewLine}");
        }
        catch
        {
            // Diagnostics must not prevent preferences from being applied.
        }
    }


    private void CharacterScaleSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        => UpdateValueLabels();

    private void CharacterXSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        => UpdateValueLabels();

    private void CharacterYSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        => UpdateValueLabels();

    private void WalkingSpeedSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        => UpdateValueLabels();

    private void UpdateValueLabels()
    {
        // The ValueChanged handlers fire while InitializeComponent() is still
        // assigning Minimum/Maximum (before the label TextBlocks exist).
        // Bail out until every name-scoped control has been instantiated.
        if (CharacterScaleValue is null || CharacterXValue is null ||
            CharacterYValue is null || WalkingSpeedValue is null)
            return;

        CharacterScaleValue.Text = $"{CharacterScaleSlider.Value:0.00}×";
        CharacterXValue.Text = $"{CharacterXSlider.Value:+0.00;-0.00}";
        CharacterYValue.Text = $"{CharacterYSlider.Value:+0.00;-0.00}";
        WalkingSpeedValue.Text = $"{WalkingSpeedSlider.Value:0.00}";
    }
}
